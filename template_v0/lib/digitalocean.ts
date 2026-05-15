/**
 * DigitalOcean REST client — Node port of modules/digitalocean.py.
 *
 * Surface:
 *   - listDroplets, getDroplet, deleteDroplet, listRegions, listSizes
 *   - createDroplet  (cloud-init root password + cost cap + token failover)
 *   - testTokens     (probe both primary + backup against /account)
 *   - DOAllTokensFailed / DropletRateLimited error classes
 *   - recentDropletCreations  (rolling-window stats for the dashboard)
 *
 * Dual-token failover: every request tries the primary token first, retries
 * with the backup on auth/5xx/network errors, and remembers which token
 * worked last via the `do_last_working_token` setting. Same behavior as
 * the Flask side; the two apps share `data/ssr.db`.
 */
import { getSetting, setSetting } from "./repos/settings"
import { logPipeline } from "./repos/logs"
import { addServer, listServers, updateServer } from "./repos/servers"

const DO_API = "https://api.digitalocean.com/v2"

// Failover triggers — try the backup token if the primary returns any of:
//   401/403  → token revoked / account suspended
//   422      → "limit exceeded" / quota errors (DO sometimes returns 422 with
//              a body explaining you've hit your droplet cap); backup account
//              has an independent quota
//   429      → rate limit on this account; backup likely has its own bucket
//   5xx/52x  → DO API or its CDN is degraded; backup may go through a
//              different upstream so worth a try
const FAILOVER_STATUSES = new Set([401, 403, 422, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524])

const DEFAULT_MAX_DROPLETS_PER_HOUR = 3

// ---------------------------------------------------------------------------
// Cost cap — rolling 1h window; refuses creates over the cap
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __ssrDropletCreations: number[] | undefined
}
function getCreations(): number[] {
  if (!globalThis.__ssrDropletCreations) globalThis.__ssrDropletCreations = []
  return globalThis.__ssrDropletCreations
}

export class DropletRateLimited extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DropletRateLimited"
  }
}

function checkAndRecordCreation(): void {
  const cap = parseInt(getSetting("max_droplets_per_hour") || String(DEFAULT_MAX_DROPLETS_PER_HOUR), 10)
  const capN = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_DROPLETS_PER_HOUR
  const now = Date.now() / 1000
  const arr = getCreations()
  // purge entries older than 1h
  for (let i = arr.length - 1; i >= 0; i--) {
    if (now - arr[i] >= 3600) arr.splice(i, 1)
  }
  if (arr.length >= capN) {
    throw new DropletRateLimited(
      `Refusing to create droplet: ${arr.length} already created in the last hour ` +
      `(cap=${capN}). Raise max_droplets_per_hour in Settings if intentional.`,
    )
  }
  arr.push(now)
}

export function recentDropletCreations(): { last_hour: number; cap: number } {
  const now = Date.now() / 1000
  const arr = getCreations()
  const recent = arr.filter((t) => now - t < 3600)
  const cap = parseInt(getSetting("max_droplets_per_hour") || String(DEFAULT_MAX_DROPLETS_PER_HOUR), 10)
  return {
    last_hour: recent.length,
    cap: Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_DROPLETS_PER_HOUR,
  }
}

// ---------------------------------------------------------------------------
// Token candidate ordering + failover request
// ---------------------------------------------------------------------------

interface TokenAttempt {
  label: string
  err: string
}

export class DOAllTokensFailed extends Error {
  attempts: [string, string][]
  constructor(attempts: [string, string][]) {
    const lines = attempts.map(([lbl, err]) => `${lbl}: ${err}`).join("; ")
    super(`All DO tokens failed — ${lines}`)
    this.name = "DOAllTokensFailed"
    this.attempts = attempts
  }
}

interface CandidateToken {
  label: string
  token: string
}

function candidateTokens(): CandidateToken[] {
  const primary = (getSetting("do_api_token") || "").trim()
  const backup = (getSetting("do_api_token_backup") || "").trim()
  const order: CandidateToken[] = []
  if (primary) order.push({ label: "primary", token: primary })
  if (backup) order.push({ label: "backup", token: backup })
  if ((getSetting("do_use_backup_first") || "0") === "1") order.reverse()
  if (order.length === 0) {
    throw new Error(
      "No DigitalOcean API token configured. " +
      "Set do_api_token (and optionally do_api_token_backup) in Settings.",
    )
  }
  return order
}

function tokenHeaders(token: string, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  }
}

interface DoRequestOpts {
  body?: unknown
  query?: Record<string, string>
  timeoutMs?: number
}

async function doRequest(method: string, path: string, opts: DoRequestOpts = {}): Promise<Response> {
  const attempts: [string, string][] = []
  const url = new URL(`${DO_API}${path}`)
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v)
  const timeoutMs = opts.timeoutMs ?? 60_000

  for (const cand of candidateTokens()) {
    let res: Response
    try {
      res = await fetch(url.toString(), {
        method,
        headers: tokenHeaders(cand.token, opts.body !== undefined),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      attempts.push([cand.label, `${(e as Error).name}: ${(e as Error).message}`])
      // Network/timeout errors are always failover-worthy
      continue
    }
    if (res.ok) {
      try { setSetting("do_last_working_token", cand.label) } catch { /* best-effort */ }
      return res
    }
    if (FAILOVER_STATUSES.has(res.status)) {
      const body = (await res.text()).slice(0, 200).replace(/\n/g, " ")
      attempts.push([cand.label, `HTTP ${res.status} — ${body}`])
      continue
    }
    // Real (non-failover) HTTP error — surface immediately
    return res
  }
  throw new DOAllTokensFailed(attempts)
}

// ---------------------------------------------------------------------------
// Token health probe
// ---------------------------------------------------------------------------

export interface TokenProbe {
  configured: boolean
  ok: boolean
  email?: string
  status?: string
  droplet_limit?: number
  error: string
}

export async function testTokens(): Promise<{ primary: TokenProbe; backup: TokenProbe }> {
  const out: { primary?: TokenProbe; backup?: TokenProbe } = {}
  for (const [label, key] of [
    ["primary", "do_api_token"],
    ["backup", "do_api_token_backup"],
  ] as const) {
    const tok = (getSetting(key) || "").trim()
    if (!tok) {
      out[label] = { configured: false, ok: false, email: "", error: "not configured" }
      continue
    }
    try {
      const res = await fetch(`${DO_API}/account`, {
        headers: tokenHeaders(tok),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) {
        const data = (await res.json()) as { account?: { email?: string; status?: string; droplet_limit?: number } }
        const a = data.account ?? {}
        out[label] = {
          configured: true, ok: true,
          email: a.email ?? "?", status: a.status ?? "?",
          droplet_limit: a.droplet_limit, error: "",
        }
      } else {
        out[label] = {
          configured: true, ok: false, email: "",
          error: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`,
        }
      }
    } catch (e) {
      out[label] = {
        configured: true, ok: false, email: "",
        error: `${(e as Error).name}: ${(e as Error).message}`,
      }
    }
  }
  return { primary: out.primary!, backup: out.backup! }
}

export async function testToken(token: string): Promise<{ ok: boolean; account?: Record<string, unknown>; error?: string }> {
  try {
    const res = await fetch(`${DO_API}/account`, { headers: tokenHeaders(token) })
    if (res.ok) {
      const data = (await res.json()) as { account: Record<string, unknown> }
      return { ok: true, account: data.account }
    }
    return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 140)}` }
  } catch (e) {
    return { ok: false, error: `${(e as Error).name}: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// Droplet read APIs
// ---------------------------------------------------------------------------

interface Droplet {
  id: number
  name: string
  status: string
  region?: { slug: string }
  size_slug?: string
  networks?: { v4?: { ip_address: string; type: string }[] }
}

/**
 * List droplets via the failover token chain.
 *
 * Tag-filter contract:
 *   listDroplets()                     → filter by tag=ssr-server (default)
 *   listDroplets({ tag: "foo" })       → filter by tag=foo
 *   listDroplets({ tag: null })        → NO filter; returns the entire fleet
 *   listDroplets({ tag: "" })          → NO filter; same as null
 *
 * Pass null when you actually want every droplet on the account (e.g.
 * import-from-do for an operator who tagged some boxes manually). DO NOT
 * use `tag: undefined` to mean "no filter" — that hits the default and
 * silently filters; that was the bug pre-2026-05-01.
 */
export async function listDroplets(opts: { tag?: string | null } = {}): Promise<Droplet[]> {
  // Distinguish "no filter requested" (tag is null/empty) from "default"
  // (tag key absent). Reaching ?? on undefined falls back to default;
  // explicit null/"" is honored as "no filter".
  const tag = opts.tag === null || opts.tag === "" ? null : (opts.tag ?? "ssr-server")
  const all: Droplet[] = []
  let page = 1
  while (true) {
    const res = await doRequest("GET", "/droplets", {
      query: { ...(tag ? { tag_name: tag } : {}), page: String(page), per_page: "200" },
      timeoutMs: 30_000,
    })
    if (!res.ok) throw new Error(`DO list_droplets HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = (await res.json()) as { droplets: Droplet[]; links?: { pages?: { next?: string } } }
    all.push(...(data.droplets ?? []))
    if (!data.links?.pages?.next) break
    page++
    if (page > 50) break
  }
  return all
}

/**
 * List droplets using a specific token (primary or backup) — bypasses the
 * failover ladder. Used by the unique-name generator so we can verify a
 * candidate server name doesn't collide on EITHER DO account, not just
 * whichever happens to be the currently-active one.
 */
export async function listDropletsForToken(
  token: string, opts: { tag?: string } = {},
): Promise<Droplet[]> {
  const tag = opts.tag ?? undefined
  const all: Droplet[] = []
  let page = 1
  while (true) {
    const url = new URL(`${DO_API}/droplets`)
    if (tag) url.searchParams.set("tag_name", tag)
    url.searchParams.set("page", String(page))
    url.searchParams.set("per_page", "200")
    const res = await fetch(url.toString(), {
      headers: tokenHeaders(token, false),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      throw new Error(`DO list_droplets (per-token) HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const data = (await res.json()) as { droplets: Droplet[]; links?: { pages?: { next?: string } } }
    all.push(...(data.droplets ?? []))
    if (!data.links?.pages?.next) break
    page++
    if (page > 50) break
  }
  return all
}

/**
 * Helper for callers that need to enumerate every configured DO token
 * (primary + backup). Returns the unique union of droplets across both
 * accounts. Failures on one token are logged-and-skipped — we use what's
 * available rather than crashing the whole sweep on one credential issue.
 */
export async function listDropletsAllTokens(opts: { tag?: string } = {}): Promise<{
  droplets: Droplet[]
  errors: { token: string; error: string }[]
}> {
  const primary = (getSetting("do_api_token") || "").trim()
  const backup = (getSetting("do_api_token_backup") || "").trim()
  const tokens: { label: string; token: string }[] = []
  if (primary) tokens.push({ label: "primary", token: primary })
  if (backup) tokens.push({ label: "backup", token: backup })

  const seen = new Set<string>()
  const droplets: Droplet[] = []
  const errors: { token: string; error: string }[] = []
  for (const t of tokens) {
    try {
      const list = await listDropletsForToken(t.token, opts)
      for (const d of list) {
        const id = String(d.id)
        if (!seen.has(id)) { seen.add(id); droplets.push(d) }
      }
    } catch (e) {
      errors.push({ token: t.label, error: (e as Error).message })
    }
  }
  return { droplets, errors }
}

export async function getDroplet(dropletId: string | number): Promise<Droplet> {
  const res = await doRequest("GET", `/droplets/${dropletId}`, { timeoutMs: 30_000 })
  if (!res.ok) throw new Error(`DO get_droplet HTTP ${res.status}`)
  const data = (await res.json()) as { droplet: Droplet }
  return data.droplet
}

export async function deleteDroplet(dropletId: string | number): Promise<boolean> {
  const res = await doRequest("DELETE", `/droplets/${dropletId}`, { timeoutMs: 30_000 })
  if (!res.ok && res.status !== 204) {
    throw new Error(`DO delete_droplet HTTP ${res.status}`)
  }
  return true
}

export async function listRegions(): Promise<{ slug: string; name: string; available?: boolean }[]> {
  const res = await doRequest("GET", "/regions", { timeoutMs: 30_000 })
  if (!res.ok) throw new Error(`DO list_regions HTTP ${res.status}`)
  const data = (await res.json()) as { regions: { slug: string; name: string; available?: boolean }[] }
  return data.regions.filter((r) => r.available !== false)
}

export async function listSizes(): Promise<{ slug: string; available?: boolean; regions?: string[] }[]> {
  const res = await doRequest("GET", "/sizes", { timeoutMs: 30_000 })
  if (!res.ok) throw new Error(`DO list_sizes HTTP ${res.status}`)
  const data = (await res.json()) as { sizes: { slug: string; available?: boolean; regions?: string[] }[] }
  return data.sizes.filter((s) => s.available !== false)
}

/**
 * Pre-flight check for `createDroplet` calls — verifies that the chosen
 * size is actually available in the chosen region BEFORE we burn an API
 * round-trip + (worse) silently enqueue a doomed background job. DO's
 * /v2/sizes returns a `regions: string[]` per size listing the slugs
 * where each size is currently provisionable. Premium Intel / AMD tiers
 * (e.g. s-2vcpu-8gb-160gb-intel) are restricted to a subset; out-of-stock
 * conditions also remove regions from the list temporarily.
 *
 * Returns:
 *   - { ok: true } when the size+region combo is valid
 *   - { ok: false, error, available_regions } when the size doesn't ship in
 *     that region (with the regions where it IS available, so the caller
 *     can surface a helpful "try one of these instead" suggestion)
 *   - { ok: false, error } when the size doesn't exist at all OR DO API fails
 *     (in those cases we can't safely degrade — return the error verbatim)
 */
export async function validateRegionSize(region: string, size: string): Promise<{
  ok: boolean
  error?: string
  available_regions?: string[]
}> {
  let sizes: { slug: string; regions?: string[] }[]
  try {
    sizes = await listSizes()
  } catch (e) {
    // DO API down — can't validate; pass through and let createDroplet's
    // own error handling surface the actual failure. Better than blocking
    // a legitimate request on a transient DO outage.
    return { ok: true }
  }
  const matched = sizes.find((s) => s.slug === size)
  if (!matched) {
    return { ok: false, error: `Size '${size}' not recognized by DO (deprecated or typo'd?)` }
  }
  const regions = matched.regions ?? []
  if (!regions.includes(region)) {
    return {
      ok: false,
      error: `Size '${size}' is not available in region '${region}'. ` +
        `It IS available in: ${regions.join(", ") || "(no regions currently — fully out of stock)"}`,
      available_regions: regions,
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Droplet create — cloud-init password + IP poll + servers row insert
// ---------------------------------------------------------------------------

function buildUserData(rootPassword: string): string {
  const safe = rootPassword.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  return `#cloud-config
chpasswd:
  list: |
    root:${safe}
  expire: false
ssh_pwauth: true
disable_root: false
runcmd:
  - sed -i 's/^#\\?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  - sed -i 's/^#\\?PermitRootLogin .*/PermitRootLogin yes/' /etc/ssh/sshd_config
  - systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload 2>/dev/null || true
`
}

function pickRegion(): string {
  const pool = (getSetting("server_regions_pool") || "nyc1,nyc3,sfo2")
    .split(",").map((r) => r.trim()).filter(Boolean)
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : "nyc3"
}

interface CreateDropletOpts {
  name: string
  region?: string
  size?: string
  image?: string
  rootPassword?: string
}

interface CreateDropletResult {
  serverId: number
  ip: string
  dropletId: string
}

/**
 * Provision a DO droplet with a cloud-init-set root password, poll for the
 * IPv4, insert a `servers` row, and return identifiers. Cost-capped.
 *
 * Idempotency: DO doesn't support idempotency keys, but droplet names are
 * unique within an account+region. We pre-check by name before POSTing
 * and re-check after a POST throw so a dropped response (timeout, 5xx,
 * partner-token failover) cannot lead to a duplicate billed droplet.
 */
export async function createDroplet(opts: CreateDropletOpts): Promise<CreateDropletResult> {
  const name = opts.name
  const size = opts.size ?? getSetting("server_droplet_size") ?? "s-2vcpu-8gb-160gb-intel"
  const region = opts.region ?? pickRegion()
  const image = opts.image ?? "ubuntu-24-04-x64"
  const rootPassword = opts.rootPassword ?? getSetting("server_root_password") ?? ""
  if (!rootPassword) {
    throw new Error("server_root_password not set; refusing to provision a droplet without a password")
  }

  // Idempotency check 1 — pre-POST. If a droplet with this name already
  // exists tagged ssr-server (across primary+backup tokens), reuse it.
  // Skips the cost-cap because we're not creating anything.
  const pre = await findExistingDroplet(name).catch(() => null)
  if (pre) {
    logPipeline(name, "do_create", "warning",
      `Droplet '${name}' already exists on DO (id=${pre.id}); reusing instead of creating duplicate.`)
    return await recoverDroplet(name, pre, region, size)
  }

  // Pre-flight cost cap — refuse before any API spend
  checkAndRecordCreation()

  logPipeline(name, "do_create", "running",
    `Creating droplet: ${name}  region=${region}  size=${size}`)
  try {
    const createRes = await doRequest("POST", "/droplets", {
      body: {
        name,
        region,
        size,
        image,
        ipv6: false,
        monitoring: true,
        tags: ["ssr-server"],
        user_data: buildUserData(rootPassword),
      },
      timeoutMs: 60_000,
    })
    if (!createRes.ok) {
      const body = await createRes.text()
      throw new Error(`DO POST /droplets HTTP ${createRes.status}: ${body.slice(0, 300)}`)
    }
    const created = (await createRes.json()) as { droplet: Droplet }
    const dropletId = String(created.droplet.id)

    // Poll for public IPv4 (up to ~5 min)
    let ip: string | null = null
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 10_000))
      const d = await getDroplet(dropletId)
      const v4 = d.networks?.v4 ?? []
      const pub = v4.find((n) => n.type === "public")
      if (pub) { ip = pub.ip_address; break }
    }
    if (!ip) throw new Error("Droplet created but no public IP assigned after 5 minutes")

    const serverId = upsertServerRow(name, ip, dropletId, region, size)

    logPipeline(name, "do_create", "completed",
      `Droplet ready: ${ip} (ID: ${dropletId})  region=${region}  size=${size}`)
    return { serverId, ip, dropletId }
  } catch (e) {
    // Idempotency check 2 — post-error. The POST may have actually reached
    // DO and created a droplet before the response was lost (timeout,
    // network error, 5xx after the create succeeded server-side). Re-list
    // by name; if we find the droplet, recover it instead of reporting
    // failure (which would prompt the operator to retry → duplicate bill).
    const recovered = await findExistingDroplet(name).catch(() => null)
    if (recovered) {
      logPipeline(name, "do_create", "warning",
        `POST failed (${(e as Error).message}) but droplet ${recovered.id} exists on DO; recovering.`)
      return await recoverDroplet(name, recovered, region, size)
    }
    logPipeline(name, "do_create", "failed", (e as Error).message)
    throw e
  }
}

/**
 * Find an existing droplet by name across primary + backup tokens.
 * Bounded by tag (ssr-server) so we never accidentally reuse a droplet
 * the operator created by hand for some other purpose.
 */
async function findExistingDroplet(name: string): Promise<Droplet | null> {
  const { droplets } = await listDropletsAllTokens({ tag: "ssr-server" })
  return droplets.find((d) => d.name === name) ?? null
}

/**
 * Insert-or-reuse a `servers` row for this droplet. Returns the row id.
 * If a row already exists with this do_droplet_id (e.g. previous run got
 * the row in but crashed before completing), reuse it; otherwise insert.
 */
function upsertServerRow(name: string, ip: string, dropletId: string, region: string, size: string): number {
  const existing = listServers().find((s) => s.do_droplet_id === dropletId)
  const maxSitesRaw = parseInt(getSetting("sites_per_server") || "60", 10)
  const maxSites = Number.isFinite(maxSitesRaw) && maxSitesRaw > 0 ? maxSitesRaw : 60
  if (existing) {
    updateServer(existing.id, { ip, region, size_slug: size, max_sites: maxSites } as Parameters<typeof updateServer>[1])
    return existing.id
  }
  const serverId = addServer(name, ip, dropletId)
  updateServer(serverId, { region, size_slug: size, max_sites: maxSites } as Parameters<typeof updateServer>[1])
  return serverId
}

/**
 * Treat a found-existing droplet as if we just created it — poll for its
 * IP if not already assigned, then upsert the servers row.
 */
async function recoverDroplet(name: string, droplet: Droplet, region: string, size: string): Promise<CreateDropletResult> {
  const dropletId = String(droplet.id)
  const v4 = droplet.networks?.v4 ?? []
  let ip = v4.find((n) => n.type === "public")?.ip_address ?? null
  if (!ip) {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 10_000))
      const d = await getDroplet(dropletId).catch(() => null)
      if (!d) continue
      const pub = (d.networks?.v4 ?? []).find((n) => n.type === "public")
      if (pub) { ip = pub.ip_address; break }
    }
  }
  if (!ip) throw new Error(`Recovered droplet ${dropletId} but no public IP assigned after 5 minutes`)
  const serverId = upsertServerRow(name, ip, dropletId, droplet.region?.slug ?? region, droplet.size_slug ?? size)
  return { serverId, ip, dropletId }
}
