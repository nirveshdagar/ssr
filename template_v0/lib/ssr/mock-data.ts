export type PipelineStatus =
  | "pending"
  | "running"
  | "completed"
  | "live"
  | "waiting"
  | "retryable_error"
  | "terminal_error"
  | "canceled"

export const PIPELINE_STEPS = [
  { id: 1, key: "acquire", label: "Acquire domain" },
  { id: 2, key: "cf_key", label: "Assign CF key" },
  { id: 3, key: "cf_zone", label: "Create CF zone" },
  { id: 4, key: "ns", label: "Set nameservers" },
  { id: 5, key: "droplet", label: "Provision droplet" },
  { id: 6, key: "sa_install", label: "Install ServerAvatar" },
  { id: 7, key: "ssl", label: "Issue SSL" },
  { id: 8, key: "llm_gen", label: "Generate site (LLM)" },
  { id: 9, key: "deploy", label: "Upload site" },
  { id: 10, key: "verify", label: "Verify HTTPS live" },
] as const

export type Domain = {
  id: string
  name: string
  status: PipelineStatus
  step: number
  server: string
  cfKey: string
  ip: string
  createdAt: string
  registrar: "Spaceship" | "Imported"
}

export const DOMAINS: Domain[] = [
  { id: "d_01", name: "lumenforge.io", status: "live", step: 10, server: "do-nyc3-01", cfKey: "cf-pool-04", ip: "164.92.18.221", createdAt: "2026-04-22 14:02", registrar: "Spaceship" },
  { id: "d_02", name: "northbeam.dev", status: "running", step: 7, server: "do-sfo3-02", cfKey: "cf-pool-01", ip: "143.198.74.12", createdAt: "2026-04-26 09:14", registrar: "Spaceship" },
  { id: "d_03", name: "quietharbor.app", status: "running", step: 4, server: "do-ams3-01", cfKey: "cf-pool-02", ip: "—", createdAt: "2026-04-26 09:48", registrar: "Spaceship" },
  { id: "d_04", name: "fernpath.co", status: "waiting", step: 5, server: "do-nyc3-03", cfKey: "cf-pool-04", ip: "—", createdAt: "2026-04-26 10:01", registrar: "Spaceship" },
  { id: "d_05", name: "boldmeridian.net", status: "retryable_error", step: 6, server: "do-sfo3-02", cfKey: "cf-pool-01", ip: "143.198.74.18", createdAt: "2026-04-25 22:11", registrar: "Spaceship" },
  { id: "d_06", name: "stoneglass.io", status: "live", step: 10, server: "do-nyc3-01", cfKey: "cf-pool-03", ip: "164.92.18.244", createdAt: "2026-04-21 11:33", registrar: "Imported" },
  { id: "d_07", name: "ridgewren.com", status: "terminal_error", step: 8, server: "do-fra1-01", cfKey: "cf-pool-05", ip: "138.197.5.91", createdAt: "2026-04-25 18:27", registrar: "Spaceship" },
  { id: "d_08", name: "halcyondrift.org", status: "live", step: 10, server: "do-fra1-01", cfKey: "cf-pool-05", ip: "138.197.5.94", createdAt: "2026-04-20 08:16", registrar: "Imported" },
  { id: "d_09", name: "embertide.io", status: "pending", step: 1, server: "—", cfKey: "—", ip: "—", createdAt: "2026-04-26 10:22", registrar: "Spaceship" },
  { id: "d_10", name: "verdantloop.app", status: "canceled", step: 3, server: "—", cfKey: "cf-pool-02", ip: "—", createdAt: "2026-04-24 16:42", registrar: "Spaceship" },
  { id: "d_11", name: "polarisbay.dev", status: "live", step: 10, server: "do-sgp1-01", cfKey: "cf-pool-06", ip: "159.65.130.4", createdAt: "2026-04-19 12:08", registrar: "Spaceship" },
  { id: "d_12", name: "thornkettle.co", status: "running", step: 9, server: "do-nyc3-02", cfKey: "cf-pool-03", ip: "164.92.18.78", createdAt: "2026-04-26 08:55", registrar: "Spaceship" },
]

export type Server = {
  id: string
  name: string
  region: string
  ip: string
  size: string
  domains: number
  capacity: number
  status: "active" | "dead" | "migrating" | "provisioning"
  createdAt: string
}

export const SERVERS: Server[] = [
  { id: "s_01", name: "do-nyc3-01", region: "NYC3", ip: "164.92.18.221", size: "s-1vcpu-1gb", domains: 18, capacity: 25, status: "active", createdAt: "2026-03-12" },
  { id: "s_02", name: "do-nyc3-02", region: "NYC3", ip: "164.92.18.78",  size: "s-1vcpu-1gb", domains: 22, capacity: 25, status: "active", createdAt: "2026-03-14" },
  { id: "s_03", name: "do-nyc3-03", region: "NYC3", ip: "164.92.18.110", size: "s-1vcpu-2gb", domains: 11, capacity: 25, status: "active", createdAt: "2026-03-19" },
  { id: "s_04", name: "do-sfo3-01", region: "SFO3", ip: "143.198.74.4",  size: "s-1vcpu-1gb", domains: 25, capacity: 25, status: "active", createdAt: "2026-02-28" },
  { id: "s_05", name: "do-sfo3-02", region: "SFO3", ip: "143.198.74.12", size: "s-1vcpu-1gb", domains: 19, capacity: 25, status: "active", createdAt: "2026-03-04" },
  { id: "s_06", name: "do-ams3-01", region: "AMS3", ip: "157.230.84.1",  size: "s-1vcpu-1gb", domains: 7,  capacity: 25, status: "provisioning", createdAt: "2026-04-26" },
  { id: "s_07", name: "do-fra1-01", region: "FRA1", ip: "138.197.5.91",  size: "s-1vcpu-2gb", domains: 14, capacity: 25, status: "active", createdAt: "2026-03-21" },
  { id: "s_08", name: "do-sgp1-01", region: "SGP1", ip: "159.65.130.4",  size: "s-1vcpu-1gb", domains: 9,  capacity: 25, status: "active", createdAt: "2026-04-02" },
  { id: "s_09", name: "do-lon1-01", region: "LON1", ip: "165.232.12.42", size: "s-1vcpu-1gb", domains: 0,  capacity: 25, status: "dead", createdAt: "2026-01-18" },
  { id: "s_10", name: "do-tor1-01", region: "TOR1", ip: "146.190.66.7",  size: "s-1vcpu-1gb", domains: 12, capacity: 25, status: "migrating", createdAt: "2026-03-30" },
]

export type CfKey = {
  id: string
  label: string
  email: string
  domains: number
  rateLimitUsed: number
  status: "healthy" | "warning" | "exhausted"
  lastUsed: string
}

export const CF_KEYS: CfKey[] = [
  { id: "cf-pool-01", label: "cf-pool-01", email: "ops+01@ssr.local", domains: 42, rateLimitUsed: 38, status: "healthy",   lastUsed: "2 min ago" },
  { id: "cf-pool-02", label: "cf-pool-02", email: "ops+02@ssr.local", domains: 51, rateLimitUsed: 71, status: "warning",   lastUsed: "just now" },
  { id: "cf-pool-03", label: "cf-pool-03", email: "ops+03@ssr.local", domains: 39, rateLimitUsed: 22, status: "healthy",   lastUsed: "5 min ago" },
  { id: "cf-pool-04", label: "cf-pool-04", email: "ops+04@ssr.local", domains: 47, rateLimitUsed: 44, status: "healthy",   lastUsed: "11 min ago" },
  { id: "cf-pool-05", label: "cf-pool-05", email: "ops+05@ssr.local", domains: 33, rateLimitUsed: 92, status: "exhausted", lastUsed: "1 min ago" },
  { id: "cf-pool-06", label: "cf-pool-06", email: "ops+06@ssr.local", domains: 36, rateLimitUsed: 18, status: "healthy",   lastUsed: "8 min ago" },
]

export type LogEvent = {
  id: string
  ts: string
  level: "info" | "warn" | "error" | "debug"
  pipeline: string
  domain: string
  step: string
  message: string
}

export const LOG_EVENTS: LogEvent[] = [
  { id: "l_001", ts: "2026-04-26 10:24:18", level: "info",  pipeline: "p_8821", domain: "northbeam.dev",   step: "ssl",       message: "Certbot acme challenge succeeded; cert installed" },
  { id: "l_002", ts: "2026-04-26 10:24:11", level: "info",  pipeline: "p_8821", domain: "northbeam.dev",   step: "sa_install",message: "ServerAvatar agent reported READY in 42s" },
  { id: "l_003", ts: "2026-04-26 10:24:02", level: "warn",  pipeline: "p_8819", domain: "fernpath.co",     step: "droplet",   message: "DO API returned 429; backing off 30s" },
  { id: "l_004", ts: "2026-04-26 10:23:57", level: "info",  pipeline: "p_8820", domain: "quietharbor.app", step: "ns",        message: "Spaceship NS update accepted" },
  { id: "l_005", ts: "2026-04-26 10:23:41", level: "error", pipeline: "p_8814", domain: "ridgewren.com",   step: "llm_gen",   message: "LLM returned malformed PHP — terminal failure after 3 retries" },
  { id: "l_006", ts: "2026-04-26 10:23:22", level: "info",  pipeline: "p_8822", domain: "thornkettle.co",  step: "deploy",    message: "rsync uploaded 4 files (12.3 KB)" },
  { id: "l_007", ts: "2026-04-26 10:22:58", level: "debug", pipeline: "p_8820", domain: "quietharbor.app", step: "cf_zone",   message: "Zone created id=4f9a... ns=ns1.cloudflare.com" },
  { id: "l_008", ts: "2026-04-26 10:22:31", level: "info",  pipeline: "p_8821", domain: "northbeam.dev",   step: "sa_install",message: "Apt update OK; installing serveravatar-agent" },
  { id: "l_009", ts: "2026-04-26 10:21:44", level: "warn",  pipeline: "p_8815", domain: "boldmeridian.net",step: "sa_install",message: "SA install timed out at 180s — scheduled retry 1/3" },
  { id: "l_010", ts: "2026-04-26 10:21:02", level: "info",  pipeline: "p_8820", domain: "quietharbor.app", step: "cf_key",    message: "Assigned cf-pool-02 (load 49%)" },
  { id: "l_011", ts: "2026-04-26 10:20:38", level: "info",  pipeline: "p_8819", domain: "fernpath.co",     step: "cf_zone",   message: "Zone created id=8a21... ns=ns1.cloudflare.com" },
  { id: "l_012", ts: "2026-04-26 10:20:14", level: "info",  pipeline: "p_8822", domain: "thornkettle.co",  step: "verify",    message: "HTTPS 200 OK — flipping status to live" },
]

export type AuditEntry = {
  id: string
  ts: string
  actor: string
  action: string
  target: string
  detail: string
}

export const AUDIT_ENTRIES: AuditEntry[] = [
  { id: "a_001", ts: "2026-04-26 10:24:11", actor: "operator", action: "pipeline.run",        target: "northbeam.dev",   detail: "Started pipeline p_8821 (full)" },
  { id: "a_002", ts: "2026-04-26 10:18:02", actor: "operator", action: "domain.bulk_update",  target: "12 domains",      detail: "Bulk SSL mode → strict on cf-pool-04" },
  { id: "a_003", ts: "2026-04-26 09:55:47", actor: "operator", action: "server.create",       target: "do-ams3-01",      detail: "Provisioned droplet s-1vcpu-1gb in AMS3" },
  { id: "a_004", ts: "2026-04-26 09:31:18", actor: "system",   action: "domain.cancel",       target: "verdantloop.app", detail: "Auto-canceled after 3 retries on step 3" },
  { id: "a_005", ts: "2026-04-26 09:14:02", actor: "operator", action: "settings.update",     target: "alerts",          detail: "Updated Slack webhook URL" },
  { id: "a_006", ts: "2026-04-26 08:46:55", actor: "operator", action: "cf_key.add",          target: "cf-pool-06",      detail: "Added new Cloudflare API key to pool" },
  { id: "a_007", ts: "2026-04-26 08:12:33", actor: "operator", action: "domain.hard_delete",  target: "oldsiteunused.io",detail: "Hard delete (DNS, droplet files, audit kept)" },
  { id: "a_008", ts: "2026-04-25 23:02:41", actor: "system",   action: "server.mark_dead",    target: "do-lon1-01",      detail: "3 consecutive health checks failed" },
  { id: "a_009", ts: "2026-04-25 22:11:09", actor: "operator", action: "pipeline.run",        target: "boldmeridian.net",detail: "Started pipeline p_8815 (full)" },
  { id: "a_010", ts: "2026-04-25 19:48:21", actor: "operator", action: "auth.login",          target: "operator",        detail: "Login from 203.0.113.42 (US)" },
]

export const ACTIVITY_FEED = [
  { id: "act_1", ts: "10:24", text: "northbeam.dev — SSL issued, step 7 → 8",        kind: "info"    as const },
  { id: "act_2", ts: "10:23", text: "quietharbor.app — nameservers set, step 4 → 5", kind: "info"    as const },
  { id: "act_3", ts: "10:23", text: "ridgewren.com — terminal error on llm_gen",     kind: "error"   as const },
  { id: "act_4", ts: "10:22", text: "thornkettle.co — verified live",                kind: "success" as const },
  { id: "act_5", ts: "10:21", text: "boldmeridian.net — retry 1/3 on sa_install",    kind: "warning" as const },
  { id: "act_6", ts: "10:18", text: "Bulk SSL mode → strict on cf-pool-04",          kind: "info"    as const },
  { id: "act_7", ts: "09:56", text: "do-ams3-01 — provisioning started",             kind: "info"    as const },
  { id: "act_8", ts: "09:31", text: "verdantloop.app — auto-canceled after 3 retries", kind: "warning" as const },
]
