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
import { addServer, updateServer } from "./repos/servers"

const DO_API = "https://api.digitalocean.com/v2"

const FAILOVER_STATUSES = new Set([401, 403, 500, 502, 503, 504, 520, 521, 522, 523, 524])

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

export async function listDroplets(opts: { tag?: string } = {}): Promise<Droplet[]> {
  const tag = opts.tag ?? "ssr-server"
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

export async function listSizes(): Promise<{ slug: string; available?: boolean }[]> {
  const res = await doRequest("GET", "/sizes", { timeoutMs: 30_000 })
  if (!res.ok) throw new Error(`DO list_sizes HTTP ${res.status}`)
  const data = (await res.json()) as { sizes: { slug: string; available?: boolean }[] }
  return data.sizes.filter((s) => s.available !== false)
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

    const serverId = addServer(name, ip, dropletId)
    const maxSitesRaw = parseInt(getSetting("sites_per_server") || "60", 10)
    const maxSites = Number.isFinite(maxSitesRaw) && maxSitesRaw > 0 ? maxSitesRaw : 60
    updateServer(serverId, { region, size_slug: size, max_sites: maxSites } as Parameters<typeof updateServer>[1])

    logPipeline(name, "do_create", "completed",
      `Droplet ready: ${ip} (ID: ${dropletId})  region=${region}  size=${size}`)
    return { serverId, ip, dropletId }
  } catch (e) {
    logPipeline(name, "do_create", "failed", (e as Error).message)
    throw e
  }
}
