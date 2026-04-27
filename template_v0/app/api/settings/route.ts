import { NextResponse, type NextRequest } from "next/server"
import { all } from "@/lib/db"
import { getSetting, setSetting } from "@/lib/repos/settings"
import { hashPasswordPbkdf2 } from "@/lib/auth"
import { isSensitive } from "@/lib/secrets-vault"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/** Same field whitelist Flask's POST /settings uses. Anything outside this
 *  list is silently ignored — we never let the form blank-update unrelated rows. */
const STRING_FIELDS = [
  "spaceship_api_key", "spaceship_api_secret",
  "registrant_first_name", "registrant_last_name",
  "registrant_email", "registrant_phone",
  "registrant_address", "registrant_city",
  "registrant_state", "registrant_zip", "registrant_country",
  "do_api_token", "do_api_token_backup",
  "serveravatar_api_key", "serveravatar_org_id",
  "sa_dashboard_email", "sa_dashboard_password",
  "llm_provider", "llm_api_key", "llm_model",
  "llm_api_key_anthropic", "llm_api_key_openai",
  "llm_api_key_gemini", "llm_api_key_openrouter",
  "smtp_server", "smtp_port", "smtp_email", "smtp_password", "notify_email",
  "telegram_bot_token", "telegram_chat_id",
  "whatsapp_provider", "whatsapp_phone", "whatsapp_apikey",
  "greenapi_instance_id", "greenapi_api_token", "greenapi_host",
  "twilio_account_sid", "twilio_auth_token",
  "twilio_from_number", "sms_to_number",
  "server_root_password",
  "live_check_interval_s",
  "dead_server_threshold_ticks",
  "max_droplets_per_hour",
] as const

const CHECKBOX_FIELDS = [
  "auto_migrate_enabled",
  "do_use_backup_first",
  "notifications_enabled",
  "email_enabled",
  "telegram_enabled",
  "whatsapp_enabled",
  "sms_enabled",
  "migrate_always_provision_new",
] as const

/**
 * GET /api/settings — return all whitelisted setting values, decrypted via
 * the secrets vault for sensitive keys. The dashboard password row is
 * surfaced as a boolean (`has_password`) — never as plaintext or hash.
 */
export async function GET(_req: NextRequest): Promise<Response> {
  const out: Record<string, string | boolean> = {}
  for (const k of STRING_FIELDS) {
    out[k] = getSetting(k) ?? ""
  }
  for (const k of CHECKBOX_FIELDS) {
    out[k] = (getSetting(k) ?? "0") === "1"
  }
  // Dashboard password — bool only
  const hashRow = all<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    "dashboard_password_hash",
  )[0]
  out["has_password"] = Boolean(hashRow?.value)

  // Read-only telemetry fields — surface DO failover state so the operator
  // knows which token last worked. Not editable (set by the runtime when
  // a probe succeeds), so it's not in STRING_FIELDS.
  out["do_last_working_token"] = getSetting("do_last_working_token") ?? ""
  return NextResponse.json({ settings: out })
}

/**
 * POST /api/settings — accept JSON body with any subset of whitelisted keys.
 * String fields with empty-string values ARE saved (matches Flask: empty
 * means "clear"). Checkbox fields are coerced to "1"/"0".
 *
 * Special handling for dashboard_password:
 *   - "" (or absent)  → leave existing hash alone (don't blank auth by accident)
 *   - "-"             → DISABLE password (clears hash row + legacy plaintext)
 *   - any other value → PBKDF2-hash and store in dashboard_password_hash
 */
export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  let count = 0

  for (const k of STRING_FIELDS) {
    if (k in body) {
      const v = String(body[k] ?? "").trim()
      setSetting(k, v)
      count++
    }
  }

  for (const k of CHECKBOX_FIELDS) {
    if (k in body) {
      const v = body[k]
      const truthy = v === true || v === 1 || v === "1" || v === "true"
      setSetting(k, truthy ? "1" : "0")
      count++
    }
  }

  // Dashboard password — special-case
  if ("dashboard_password" in body) {
    const newPw = String(body["dashboard_password"] ?? "").trim()
    if (newPw === "-") {
      setSetting("dashboard_password_hash", "")
      setSetting("dashboard_password", "")
      count++
    } else if (newPw) {
      setSetting("dashboard_password_hash", hashPasswordPbkdf2(newPw))
      setSetting("dashboard_password", "") // clear legacy plaintext
      count++
    }
    // empty → leave alone
  }

  appendAudit("settings_save", "", `${count} fields submitted`, ip)
  return NextResponse.json({ ok: true, count })
}

// Re-export for tests / debug — confirm a key is encrypted by the vault path
export const _isSensitiveExport = isSensitive
