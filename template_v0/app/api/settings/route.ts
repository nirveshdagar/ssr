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
  "serveravatar_api_key_backup", "serveravatar_org_id_backup",
  "sa_dashboard_email", "sa_dashboard_password",
  "llm_provider", "llm_api_key", "llm_model",
  "llm_api_key_anthropic", "llm_api_key_openai",
  "llm_api_key_gemini", "llm_api_key_openrouter",
  "llm_api_key_moonshot",
  "llm_timeout_ms",
  "llm_max_output_tokens",
  "cloudflare_account_id", "cloudflare_workers_ai_token",
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
  // Only openai (codex) has a CLI panel now. The gemini CLI panel was
  // removed because gemini-cli ≥ 0.38 hard-rejects non-interactive OAuth.
  // The setting key llm_cli_enabled_gemini is no longer accepted on writes
  // — any stale "1" left in the DB is harmless because website-generator's
  // CLI_CAPABLE_PROVIDERS no longer includes "gemini" so cliMode can't fire.
  "llm_cli_enabled_openai",
] as const

/**
 * GET /api/settings — return all whitelisted setting values. Sensitive
 * keys are surfaced ONLY as `<key>_set: true|false` booleans + a last-4
 * mask preview, never as plaintext. The Settings UI uses these to render
 * "configured" badges; an operator who needs to view a real value must
 * rotate it (POST a new value) instead of reading the existing one.
 *
 * Why: a single stolen session cookie (XSS, cookie disclosure, malicious
 * extension) used to walk away with every infra credential in one GET.
 * Encryption-at-rest is moot if the API serves plaintext to any cookie.
 */
function maskTail(v: string): string {
  if (!v) return ""
  if (v.length <= 4) return "•".repeat(v.length)
  return "•".repeat(Math.max(4, v.length - 4)) + v.slice(-4)
}

export async function GET(_req: NextRequest): Promise<Response> {
  const out: Record<string, string | boolean> = {}
  for (const k of STRING_FIELDS) {
    const raw = getSetting(k) ?? ""
    if (isSensitive(k)) {
      // Boolean "is it set" + masked preview. Operator UI shows badges, never
      // the real value. The plaintext only leaves the DB on the write path.
      out[`${k}_set`] = raw.length > 0
      out[`${k}_preview`] = raw.length > 0 ? maskTail(raw) : ""
    } else {
      out[k] = raw
    }
  }
  for (const k of CHECKBOX_FIELDS) {
    out[k] = (getSetting(k) ?? "0") === "1"
  }
  // Dashboard password — bool only (was already special-cased)
  const hashRow = all<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    "dashboard_password_hash",
  )[0]
  out["has_password"] = Boolean(hashRow?.value)

  // Read-only telemetry — surface DO failover state so the operator knows
  // which token last worked. Not a secret value (it's just "primary" or
  // "backup"), but is not editable.
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
  const changedKeys: string[] = []
  let count = 0

  for (const k of STRING_FIELDS) {
    if (k in body) {
      const v = String(body[k] ?? "").trim()
      // Sensitive fields are masked on GET; the UI submits empty for "leave
      // alone" because it never sees the real value to begin with. Without
      // this guard, every Save All Settings click would blank the secret.
      // Operators clear a sensitive value by sending the literal "-" (mirrors
      // the dashboard_password convention below).
      if (isSensitive(k) && v === "") continue
      const finalV = isSensitive(k) && v === "-" ? "" : v
      setSetting(k, finalV)
      changedKeys.push(k)
      count++
    }
  }

  for (const k of CHECKBOX_FIELDS) {
    if (k in body) {
      const v = body[k]
      const truthy = v === true || v === 1 || v === "1" || v === "true"
      setSetting(k, truthy ? "1" : "0")
      changedKeys.push(k)
      count++
    }
  }

  // Dashboard password — special-case
  if ("dashboard_password" in body) {
    const newPw = String(body["dashboard_password"] ?? "").trim()
    if (newPw === "-") {
      setSetting("dashboard_password_hash", "")
      setSetting("dashboard_password", "")
      changedKeys.push("dashboard_password")
      count++
    } else if (newPw) {
      setSetting("dashboard_password_hash", hashPasswordPbkdf2(newPw))
      setSetting("dashboard_password", "") // clear legacy plaintext
      changedKeys.push("dashboard_password")
      count++
    }
    // empty → leave alone
  }

  // Audit lists the field NAMES (not values) so a forensics trail after a
  // credential rotation incident shows what was rotated when. Truncate to
  // keep the audit row readable when many fields are saved at once.
  const fieldsLabel = changedKeys.length > 20
    ? `[${changedKeys.slice(0, 20).join(",")},+${changedKeys.length - 20}]`
    : `[${changedKeys.join(",")}]`
  appendAudit("settings_save", "", `count=${count} fields=${fieldsLabel}`, ip)
  return NextResponse.json({ ok: true, count })
}

// Re-export for tests / debug — confirm a key is encrypted by the vault path
export const _isSensitiveExport = isSensitive
