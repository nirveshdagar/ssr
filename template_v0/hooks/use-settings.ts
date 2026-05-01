"use client"
import useSWR from "swr"

export interface SettingsValues {
  // strings
  spaceship_api_key: string
  spaceship_api_secret: string
  registrant_first_name: string
  registrant_last_name: string
  registrant_email: string
  registrant_phone: string
  registrant_address: string
  registrant_city: string
  registrant_state: string
  registrant_zip: string
  registrant_country: string
  do_api_token: string
  do_api_token_backup: string
  serveravatar_api_key: string
  serveravatar_org_id: string
  serveravatar_api_key_backup: string
  serveravatar_org_id_backup: string
  sa_dashboard_email: string
  sa_dashboard_password: string
  llm_provider: string
  llm_api_key: string
  llm_model: string
  llm_api_key_anthropic: string
  llm_api_key_openai: string
  llm_api_key_gemini: string
  llm_api_key_openrouter: string
  llm_api_key_moonshot: string
  llm_timeout_ms: string
  llm_max_output_tokens: string
  cloudflare_account_id: string
  cloudflare_workers_ai_token: string
  /** Long-lived OAuth token for the local `claude` CLI. When set, the
   *  spawn passes it via CLAUDE_CODE_OAUTH_TOKEN env so the binary
   *  authenticates without needing ~/.claude/.credentials.json — useful
   *  on headless servers where the browser-based `claude setup-token`
   *  round-trip isn't practical. Generate one on a desktop with
   *  `claude setup-token` and paste here. */
  claude_code_oauth_token: string
  /** Read-only telemetry — populated by lib/llm-cli.ts (real-time, on every
   *  CLI call) and lib/auto-heal.ts:checkClaudeCodeOauthHealth (24h
   *  sentinel). Surfaced in the Settings UI as a colored health badge. */
  claude_code_oauth_token_status: string  // "ok" | "expired" | "missing" | "binary_missing" | "unknown" | ""
  claude_code_oauth_token_last_check_at: string  // ISO timestamp
  claude_code_oauth_token_last_ok_at: string     // ISO timestamp
  // CLI-auth toggles — when on, ignore the per-provider API key above and
  // shell out to the local `gemini` / `codex` binary that's already
  // OAuth-logged-in on this machine. Only OpenAI and Gemini support this.
  llm_cli_enabled_openai: boolean
  smtp_server: string
  smtp_port: string
  smtp_email: string
  smtp_password: string
  notify_email: string
  telegram_bot_token: string
  telegram_chat_id: string
  whatsapp_provider: string
  whatsapp_phone: string
  whatsapp_apikey: string
  greenapi_instance_id: string
  greenapi_api_token: string
  greenapi_host: string
  twilio_account_sid: string
  twilio_auth_token: string
  twilio_from_number: string
  sms_to_number: string
  server_root_password: string
  live_check_interval_s: string
  dead_server_threshold_ticks: string
  max_droplets_per_hour: string
  sites_per_server: string
  cf_domains_per_key: string
  /** Default DO region slug for new droplets + migration (e.g. "nyc1",
   *  "blr1", "fra1"). Empty falls through to the legacy "nyc1" hardcode. */
  do_default_region: string
  /** Default DO size slug for new droplets + migration (e.g.
   *  "s-1vcpu-1gb", "s-2vcpu-8gb-160gb-intel"). Empty falls through to
   *  the legacy "s-1vcpu-1gb" hardcode for /api/servers/create and
   *  "s-2vcpu-4gb" for SA-side create. */
  do_default_size: string
  // booleans
  auto_migrate_enabled: boolean
  auto_cleanup_dead_servers: boolean
  do_use_backup_first: boolean
  notifications_enabled: boolean
  email_enabled: boolean
  telegram_enabled: boolean
  whatsapp_enabled: boolean
  sms_enabled: boolean
  migrate_always_provision_new: boolean
  // info / read-only
  has_password: boolean
  /** "primary" | "backup" | "" — set by runtime when a DO probe succeeds. */
  do_last_working_token: string
  // write-only — never returned by GET, only sent on save
  dashboard_password?: string
}

const fetcher = async (url: string): Promise<{ settings: SettingsValues }> => {
  const r = await fetch(url, { credentials: "same-origin" })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export function useSettings() {
  const { data, error, isLoading, mutate } = useSWR<{ settings: SettingsValues }>(
    "/api/settings", fetcher, { revalidateOnFocus: false },
  )
  return { settings: data?.settings, error, isLoading, mutate }
}

export async function saveSettings(patch: Partial<SettingsValues>): Promise<{ ok: boolean; count: number }> {
  const r = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(patch),
  })
  if (!r.ok) throw new Error(`save HTTP ${r.status}`)
  return r.json()
}
