/**
 * Preflight checks — Node port of modules/preflight.py.
 *
 * Run all credential + capacity validations BEFORE step 1 of the pipeline
 * starts. Each check is a single API hit; the aggregate budget is ~10s on
 * a healthy network. Fails fast on misconfiguration so we don't burn 5min
 * provisioning a CF zone before discovering the SA token expired.
 *
 * Aggregate `runAll()` returns `{ ok, checks: {<name>: <result>} }` —
 * matches the shape the Flask `/api/preflight/<domain>` endpoint returns
 * so the existing dashboard rendering can consume both.
 */

import { all } from "./db"
import { getSetting } from "./repos/settings"

export interface CheckResult {
  ok: boolean
  message: string
  detail?: Record<string, unknown>
}

function ok(message: string, detail?: Record<string, unknown>): CheckResult {
  const r: CheckResult = { ok: true, message }
  if (detail) r.detail = detail
  return r
}
function fail(message: string, detail?: Record<string, unknown>): CheckResult {
  const r: CheckResult = { ok: false, message }
  if (detail) r.detail = detail
  return r
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

export function checkCfPool(): CheckResult {
  const rows = all<{ id: number; alias: string | null; email: string; domains_used: number; max_domains: number }>(
    `SELECT id, alias, email, domains_used, max_domains
       FROM cf_keys
      WHERE is_active = 1 AND domains_used < max_domains`,
  )
  const totalActive = (all<{ n: number }>(`SELECT COUNT(*) AS n FROM cf_keys WHERE is_active = 1`)[0]?.n) ?? 0
  if (rows.length === 0) {
    if (totalActive === 0) return fail("No active CF keys in the pool. Add one in Settings.")
    return fail(
      `All ${totalActive} active CF keys are at capacity. ` +
      `Add a new key or raise max_domains on an existing one.`,
    )
  }
  const available = rows.reduce((s, r) => s + (r.max_domains - r.domains_used), 0)
  return ok(`${rows.length} key(s) with capacity, ${available} domain slot(s) free`)
}

export async function checkDoToken(): Promise<CheckResult> {
  const tok = (getSetting("do_api_token") || "").trim()
  if (!tok) return fail("DO_API_TOKEN not set in Settings")
  try {
    const r = await fetch("https://api.digitalocean.com/v2/account", {
      headers: { Authorization: `Bearer ${tok}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      return fail(`DO API rejected token (HTTP ${r.status})`, { body: (await r.text()).slice(0, 140) })
    }
    const j = (await r.json()) as { account?: { email?: string; status?: string; droplet_limit?: number } }
    const acc = j.account ?? {}
    return ok(
      `DO ok (${acc.email ?? "?"}, droplet_limit=${acc.droplet_limit ?? "?"})`,
      { email: acc.email, droplet_limit: acc.droplet_limit, status: acc.status },
    )
  } catch (e) {
    return fail(`DO API unreachable: ${(e as Error).name}: ${(e as Error).message}`)
  }
}

export async function checkSaAuth(): Promise<CheckResult> {
  const tok = (getSetting("serveravatar_api_key") || "").trim()
  const org = (getSetting("serveravatar_org_id") || "").trim()
  if (!tok) return fail("SERVERAVATAR_API_KEY not set in Settings")
  if (!org) return fail("SERVERAVATAR_ORG_ID not set in Settings")
  try {
    const r = await fetch(`https://api.serveravatar.com/organizations/${org}`, {
      headers: { Authorization: tok, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      return fail(`SA API rejected (HTTP ${r.status})`, { body: (await r.text()).slice(0, 140) })
    }
    return ok(`SA ok (org=${org})`)
  } catch (e) {
    return fail(`SA API unreachable: ${(e as Error).name}: ${(e as Error).message}`)
  }
}

export async function checkSpaceshipAuth(opts: { skipPurchase?: boolean } = {}): Promise<CheckResult> {
  if (opts.skipPurchase) return ok("Skipped (skip_purchase=True)")
  const apiKey = (getSetting("spaceship_api_key") || "").trim()
  const apiSecret = (getSetting("spaceship_api_secret") || "").trim()
  if (!apiKey || !apiSecret) return fail("SPACESHIP_API_KEY / _SECRET not both set")
  try {
    const r = await fetch("https://spaceship.dev/api/v1/domains?take=1", {
      headers: {
        "X-API-Key": apiKey,
        "X-API-Secret": apiSecret,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      return fail(`Spaceship API rejected (HTTP ${r.status})`, { body: (await r.text()).slice(0, 140) })
    }
    return ok("Spaceship ok")
  } catch (e) {
    return fail(`Spaceship unreachable: ${(e as Error).name}: ${(e as Error).message}`)
  }
}

export function checkLlmKey(): CheckResult {
  const provider = (getSetting("llm_provider") || "anthropic").trim().toLowerCase()
  const key = (getSetting(`llm_api_key_${provider}`) || "").trim() ||
              (getSetting("llm_api_key") || "").trim()
  if (!key) return fail(`LLM provider=${provider} but no API key configured`)
  return ok(`LLM provider=${provider} key configured (${key.length} chars)`)
}

export function checkServerCapacity(): CheckResult {
  const rows = all<{
    id: number; name: string; ip: string;
    sites_count: number; max_sites: number;
  }>(
    `SELECT s.id, s.name, s.ip,
            (SELECT COUNT(*) FROM domains d WHERE d.server_id = s.id) AS sites_count,
            s.max_sites
       FROM servers s
      WHERE s.status = 'ready'`,
  )
  const available = rows.filter((r) => (r.sites_count ?? 0) < (r.max_sites ?? 60))
  if (available.length > 0) {
    return ok(
      `${available.length} ready server(s) with capacity`,
      {
        servers: available.map((r) => ({
          name: r.name, ip: r.ip, sites: r.sites_count, max: r.max_sites,
        })),
      },
    )
  }
  if (rows.length > 0) {
    return fail(
      `All ${rows.length} ready server(s) are at max_sites. ` +
      `Pipeline will try to provision a new droplet.`,
    )
  }
  return fail(
    "No ready servers. Pipeline will try to provision a new droplet " +
    "(requires healthy DO token).",
  )
}

export function checkRootPassword(): CheckResult {
  const pw = (getSetting("server_root_password") || "").trim()
  if (!pw) {
    return fail(
      "server_root_password not set. New droplets won't be reachable via " +
      "password SSH for setup. Set in Settings.",
    )
  }
  return ok(`Root password set (${pw.length} chars)`)
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export interface PreflightReport {
  ok: boolean
  checks: Record<string, CheckResult>
}

export async function runAll(opts: { skipPurchase?: boolean } = {}): Promise<PreflightReport> {
  // Sequential — total budget ~10s on a healthy network. Could parallelize
  // but the order is informative for the dashboard (CF first since pipeline
  // step 2 needs it).
  const checks: Record<string, CheckResult> = {
    cf_pool:         checkCfPool(),
    do_token:        await checkDoToken(),
    sa_auth:         await checkSaAuth(),
    spaceship_auth:  await checkSpaceshipAuth({ skipPurchase: opts.skipPurchase }),
    llm_key:         checkLlmKey(),
    server_capacity: checkServerCapacity(),
    root_password:   checkRootPassword(),
  }
  return {
    ok: Object.values(checks).every((c) => c.ok),
    checks,
  }
}
