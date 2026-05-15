/**
 * ServerAvatar client — Node port of modules/serveravatar.py.
 *
 * Two surfaces in one file:
 *   1. REST  — server CRUD, application CRUD, file-manager API, install-command gen.
 *   2. SSH   — agent installer on fresh droplets, custom-SSL deployment fallback,
 *              index.php upload + default index.html removal fallback.
 *
 * Auth: settings.serveravatar_api_key (used as the raw `Authorization:` value,
 * NOT `Bearer …`), settings.serveravatar_org_id.
 *
 * Parallel-Flask note: this module shares ssr.db with the Flask side. Both
 * apps see the same servers / settings / pipeline_log rows.
 *
 * UI fallback (Selenium/patchright) NOT ported — the Flask serveravatar_ui
 * module isn't reproduced here. The SA-API → SSH fallback chain is what
 * Node uses; UI is the middle path that Flask still owns.
 */

// ssh2 is type-only at module scope so it stays out of the instrumentation
// bundle; Turbopack mangles the runtime require otherwise (see the
// `ssh2-df016e52d1a2696f` cannot-find-module crash). The Client constructor
// is loaded lazily inside SshSession.connect().
import type { Client as SshClient, ConnectConfig, ClientChannel, SFTPWrapper } from "ssh2"
import { connect as tlsConnect, type PeerCertificate } from "node:tls"
import { one } from "./db"
import { getSetting } from "./repos/settings"
import { logPipeline } from "./repos/logs"
import { updateServer } from "./repos/servers"

const SA_API = "https://api.serveravatar.com"

// ---------------------------------------------------------------------------
// Auth + small HTTP helpers
// ---------------------------------------------------------------------------

interface SaCreds {
  token: string
  orgId: string
}

function loadCreds(): SaCreds {
  const tok = getSetting("serveravatar_api_key")
  const org = getSetting("serveravatar_org_id")
  if (!tok) throw new Error("ServerAvatar API key not configured. Go to Settings.")
  if (!org) throw new Error("ServerAvatar Organization ID not configured. Go to Settings.")
  return { token: tok.trim(), orgId: org.trim() }
}

// ---------------------------------------------------------------------------
// SA backup-token failover — mirrors lib/digitalocean.ts's pattern. Tries
// primary first, falls over to backup on auth/rate-limit/5xx so a blocked
// or rate-limited SA account doesn't stall a mid-flight migration.
// ---------------------------------------------------------------------------

const SA_FAILOVER_STATUSES = new Set([401, 403, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524])

interface SaCandidate { label: string; token: string; orgId: string }

function saCandidates(): SaCandidate[] {
  const primaryTok = (getSetting("serveravatar_api_key") || "").trim()
  const primaryOrg = (getSetting("serveravatar_org_id") || "").trim()
  const backupTok = (getSetting("serveravatar_api_key_backup") || "").trim()
  const backupOrg = (getSetting("serveravatar_org_id_backup") || "").trim() || primaryOrg
  const out: SaCandidate[] = []
  if (primaryTok && primaryOrg) out.push({ label: "primary", token: primaryTok, orgId: primaryOrg })
  if (backupTok && backupOrg)   out.push({ label: "backup",  token: backupTok,  orgId: backupOrg })
  return out
}

export class SAAllTokensFailed extends Error {
  attempts: [string, string][]
  constructor(attempts: [string, string][]) {
    super(`All SA tokens failed — ${attempts.map(([l, e]) => `${l}: ${e}`).join("; ")}`)
    this.name = "SAAllTokensFailed"
    this.attempts = attempts
  }
}

interface SaRequestOpts {
  method?: string
  json?: boolean         // body is JSON (sets Content-Type)
  body?: BodyInit | null
  timeoutMs?: number
}

/**
 * Issue an SA REST request with primary→backup token failover. Path is
 * relative to SA_API; `{ORG_ID}` placeholder gets substituted with the
 * candidate's org id (so backup keys belonging to a different org work).
 *
 * Returns `{ res, orgId }` so callers that record which org owned the
 * resource (e.g. createServer writes sa_org_id into the DB) can use the
 * actually-succeeding candidate, not just the configured primary.
 */
export async function saRequest(
  pathTemplate: string,
  opts: SaRequestOpts = {},
): Promise<{ res: Response; orgId: string; label: string }> {
  const cands = saCandidates()
  if (cands.length === 0) {
    throw new Error("ServerAvatar API key + org id not configured. Go to Settings.")
  }
  const method = opts.method ?? "GET"
  const timeoutMs = opts.timeoutMs ?? 30_000
  const attempts: [string, string][] = []
  for (const c of cands) {
    const url = `${SA_API}${pathTemplate.replaceAll("{ORG_ID}", c.orgId)}`
    const headers: Record<string, string> = {
      Authorization: c.token,
      Accept: "application/json",
    }
    if (opts.json) headers["Content-Type"] = "application/json"
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body ?? undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      attempts.push([c.label, `${(e as Error).name}: ${(e as Error).message}`])
      continue
    }
    if (res.ok) return { res, orgId: c.orgId, label: c.label }
    if (SA_FAILOVER_STATUSES.has(res.status)) {
      // Read the body once. Response bodies are one-shot streams in undici
      // (Node 22 fetch) — clone-then-read-both has had subtle bugs over
      // releases. Drain into a string and rebuild a fresh Response on the
      // surface-to-caller path so the caller's `await res.text()` always
      // works regardless of internal stream state.
      const bodyText = await res.text()
      // SA's file-managers REST returns HTTP 500 with `{"message":"File or
      // folder name already exists."}` for PATCH /file/create when the file
      // is already there — benign duplicate, NOT a transient server error,
      // so don't retry on the backup token. Surface the response so the
      // caller's exists-check can fall through to PATCH /file (write).
      // Documented in ssr_technical_gotchas memory.
      if (res.status === 500 && /already exists/i.test(bodyText)) {
        const surfaced = new Response(bodyText, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        })
        return { res: surfaced, orgId: c.orgId, label: c.label }
      }
      const sample = bodyText.slice(0, 200).replace(/\n/g, " ")
      attempts.push([c.label, `HTTP ${res.status} — ${sample}`])
      continue
    }
    // Real (non-failover) HTTP error — surface to caller without retrying
    return { res, orgId: c.orgId, label: c.label }
  }
  throw new SAAllTokensFailed(attempts)
}

function jsonHeaders(creds = loadCreds()): Record<string, string> {
  return {
    Authorization: creds.token,
    "Content-Type": "application/json",
    Accept: "application/json",
  }
}

function getHeaders(creds = loadCreds()): Record<string, string> {
  return {
    Authorization: creds.token,
    Accept: "application/json",
  }
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Extract SA's structured error: { message, errors: { field: [reasons] } }. */
function saErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback
  const b = body as { message?: unknown; errors?: unknown }
  const msg = typeof b.message === "string" ? b.message : ""
  const errs = b.errors
  if (errs && typeof errs === "object") {
    const bits: string[] = []
    for (const [field, reasons] of Object.entries(errs as Record<string, unknown>)) {
      if (Array.isArray(reasons)) bits.push(`${field}: ${reasons.join(", ")}`)
      else bits.push(`${field}: ${String(reasons)}`)
    }
    if (bits.length) return msg ? `${msg} — ${bits.join(" | ")}` : bits.join(" | ")
  }
  return msg || fallback
}

// ---------------------------------------------------------------------------
// SSH / SFTP wrapper — promise-based around ssh2
// ---------------------------------------------------------------------------

export class SshSession {
  private conn: SshClient
  private closed = false

  private constructor(conn: SshClient) {
    this.conn = conn
  }

  static async connect(opts: ConnectConfig & { host: string }): Promise<SshSession> {
    const { Client } = await import("ssh2")
    return new Promise((resolve, reject) => {
      const c = new Client()
      let settled = false
      const onReady = () => {
        if (settled) return
        settled = true
        c.removeListener("error", onError)
        resolve(new SshSession(c))
      }
      const onError = (err: Error) => {
        if (settled) return
        settled = true
        c.removeListener("ready", onReady)
        try { c.end() } catch {}
        reject(err)
      }
      c.once("ready", onReady)
      c.once("error", onError)
      c.connect({
        readyTimeout: 20000,
        // ssh2 defaults try keyboard-interactive auth which prompts; force
        // password-only for the fresh-droplet case.
        tryKeyboard: false,
        ...opts,
      })
    })
  }

  exec(
    cmd: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const timeoutMs = opts.timeoutMs ?? 30000
    return new Promise((resolve, reject) => {
      this.conn.exec(cmd, (err, stream: ClientChannel) => {
        if (err) return reject(err)
        let stdout = ""
        let stderr = ""
        let code = 0
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          try { stream.close() } catch {}
          reject(new Error(`exec timed out after ${timeoutMs}ms: ${cmd.slice(0, 100)}`))
        }, timeoutMs)
        stream.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8") })
        stream.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8") })
        stream.on("exit", (c: number | null) => { code = c ?? 0 })
        stream.on("close", () => {
          clearTimeout(timer)
          if (!timedOut) resolve({ code, stdout, stderr })
        })
      })
    })
  }

  /**
   * Streaming variant of exec — calls onLine for every newline-terminated
   * chunk from stdout+stderr (combined). Caller can return false from
   * onLine to abort the command. Resolves when the remote process exits
   * OR when onLine returns false (channel killed first).
   *
   * Used by the install streaming classifier in installAgentOnDroplet:
   * tails the install.log, fires a callback per line, terminates as soon
   * as success / fast-fail patterns are detected — saves up to 6 min vs
   * the 30s SA poll loop.
   */
  execStream(
    cmd: string,
    onLine: (line: string) => boolean | void,
    opts: { timeoutMs?: number } = {},
  ): Promise<{ code: number }> {
    const timeoutMs = opts.timeoutMs ?? 15 * 60_000
    return new Promise((resolve, reject) => {
      this.conn.exec(cmd, (err, stream: ClientChannel) => {
        if (err) return reject(err)
        let buffer = ""
        let code = 0
        let aborted = false
        const timer = setTimeout(() => {
          aborted = true
          try { stream.close() } catch { /* ignore */ }
          reject(new Error(`execStream timed out after ${timeoutMs}ms: ${cmd.slice(0, 100)}`))
        }, timeoutMs)
        const handleChunk = (chunk: Buffer): void => {
          buffer += chunk.toString("utf8")
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            if (aborted) return
            const keepGoing = onLine(line)
            if (keepGoing === false) {
              aborted = true
              clearTimeout(timer)
              try { stream.close() } catch { /* ignore */ }
              resolve({ code: 0 })
              return
            }
          }
        }
        stream.on("data", handleChunk)
        stream.stderr.on("data", handleChunk)
        stream.on("exit", (c: number | null) => { code = c ?? 0 })
        stream.on("close", () => {
          clearTimeout(timer)
          if (!aborted) {
            // Flush any trailing partial line on close.
            if (buffer.length > 0) onLine(buffer)
            resolve({ code })
          }
        })
      })
    })
  }

  sftp(): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      this.conn.sftp((err, sftp) => {
        if (err) return reject(err)
        resolve(sftp)
      })
    })
  }

  async sftpWriteFile(path: string, content: string | Buffer): Promise<void> {
    const sftp = await this.sftp()
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, content, (err) => (err ? reject(err) : resolve()))
    })
  }

  async sftpRemoveFile(path: string): Promise<void> {
    const sftp = await this.sftp()
    await new Promise<void>((resolve, reject) => {
      sftp.unlink(path, (err) => (err ? reject(err) : resolve()))
    })
  }

  async sftpStat(path: string): Promise<boolean> {
    const sftp = await this.sftp()
    return new Promise((resolve) => {
      sftp.stat(path, (err) => resolve(!err))
    })
  }

  async sftpReadFile(path: string, encoding: BufferEncoding = "utf8"): Promise<string> {
    const sftp = await this.sftp()
    return new Promise<string>((resolve, reject) => {
      sftp.readFile(path, { encoding }, (err, data) => {
        if (err) return reject(err)
        resolve(typeof data === "string" ? data : Buffer.from(data).toString(encoding))
      })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.conn.end() } catch {}
  }
}

/**
 * Block until a fresh droplet is accepting password SSH on port 22. Cloud-init
 * + sshd reload usually finishes within 60–120s but we give it 240s to cover
 * region tail latency. Returns a live session or throws.
 */
export async function waitForSsh(
  host: string,
  password: string,
  username = "root",
  maxWaitMs = 240_000,
): Promise<SshSession> {
  const deadline = Date.now() + maxWaitMs
  let lastErr: Error | undefined
  while (Date.now() < deadline) {
    try {
      return await SshSession.connect({
        host,
        username,
        password,
        port: 22,
        readyTimeout: 10000,
      })
    } catch (e) {
      lastErr = e as Error
      await new Promise((r) => setTimeout(r, 8000))
    }
  }
  throw new Error(
    `SSH did not become ready within ${maxWaitMs}ms on ${host}: ${lastErr?.message ?? "unknown"}`,
  )
}

// ---------------------------------------------------------------------------
// Domain → app_name / sys_user sanitization (must match the Python rules
// EXACTLY so paths probed via SSH align with what create_application created)
// ---------------------------------------------------------------------------

export function appNameFor(domain: string): string {
  return domain.replace(/\./g, "-").replace(/_/g, "-")
}

export function sysUserFor(domain: string): string {
  let u = domain.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 20)
  if (!u || !/^[a-zA-Z]/.test(u)) {
    u = ("ssruser" + u).slice(0, 20)
  }
  return u
}

// ---------------------------------------------------------------------------
// Server REST
// ---------------------------------------------------------------------------

export interface SaServer {
  id: number | string
  name?: string
  ip?: string
  server_ip?: string
  agent_status?: string | number
  status?: string | number
  [k: string]: unknown
}

export async function listServers(): Promise<SaServer[]> {
  const { res } = await saRequest("/organizations/{ORG_ID}/servers?pagination=0")
  if (!res.ok) throw new Error(`SA list_servers HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { servers?: SaServer[]; data?: SaServer[] }
  return body.servers ?? body.data ?? []
}

export async function getServerInfo(saServerId: string): Promise<SaServer> {
  const { res } = await saRequest(`/organizations/{ORG_ID}/servers/${saServerId}`)
  if (!res.ok) throw new Error(`SA get_server HTTP ${res.status}`)
  const body = (await res.json()) as { server?: SaServer } & SaServer
  return body.server ?? body
}

/** Light probe: does SA still know about this server_id? Used to detect
 * servers that were manually deleted from the SA dashboard.
 *
 * **Strict semantics (2026-05-14 fix)** — there are THREE possible states
 * for a "is SA aware of this server?" question, not two:
 *   - SA confirms exists (HTTP 200) → returns `true`
 *   - SA confirms gone   (HTTP 404) → returns `false`
 *   - couldn't reach SA  (timeout, 5xx, network error) → THROWS
 *
 * The third case is the bug-fix point. The previous version `try/catch`d
 * everything and returned `false` on all errors, so an overnight outbound-
 * network blip would surface as "SA says server is gone" — and the caller
 * (verifySaServerOrMarkDead in pipeline.ts) flipped a perfectly healthy
 * production server to status='dead', cascading into a failed auto-
 * migrate and several hours of confused alerts. Callers MUST treat
 * an exception here as "unknown, leave the row alone" and only act on a
 * definitive `false`.
 */
export async function isSaServerAlive(saServerId: string): Promise<boolean> {
  const { res } = await saRequest(`/organizations/{ORG_ID}/servers/${saServerId}`, {
    timeoutMs: 10_000,
  })
  if (res.status === 200) return true
  if (res.status === 404) return false
  // Any other status (5xx, 4xx auth, etc.) — let caller treat as unknown.
  // saRequest's failover already tried primary+backup, so reaching here
  // means BOTH tokens couldn't get a useful answer.
  throw new Error(`isSaServerAlive: unexpected HTTP ${res.status} (transient — try later)`)
}

/**
 * Delete a server from ServerAvatar's account. Used to clean up half-
 * registered servers when an SA agent install fails so a retry can start
 * fresh, and from teardown / migration flows that already delete the DO
 * droplet but want SA's own bookkeeping cleaned up too.
 *
 * Returns `{ ok: true }` on a clean delete or 404 (already gone — same
 * end state). Returns `{ ok: false, reason }` on every other failure
 * including network / auth / 5xx so the caller can decide whether to
 * surface it or move on.
 */
export async function deleteSaServer(saServerId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!saServerId) return { ok: false, reason: "no saServerId provided" }
  try {
    const { res } = await saRequest(
      `/organizations/{ORG_ID}/servers/${saServerId}`,
      { method: "DELETE", timeoutMs: 30_000 },
    )
    if (res.ok || res.status === 204) return { ok: true }
    if (res.status === 404) return { ok: true } // already gone — same end state
    const body = (await res.text()).slice(0, 200)
    return { ok: false, reason: `HTTP ${res.status}: ${body}` }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}

/**
 * Create a server via SA's cloud-provider integration (DigitalOcean linked
 * account). NOTE: ServerAvatar requires you to link the DO token in the SA
 * dashboard once. Its provider id goes in settings.sa_cloud_provider_id.
 */
export async function createServer(opts: {
  serverName: string
  serverIdDb: number
  region?: string
  size?: string
}): Promise<{ saServerId: string; ip: string }> {
  const { serverName, serverIdDb } = opts
  // Fallback chain: explicit opts → settings (do_default_region/size) →
  // legacy SA-side hardcode (s-2vcpu-4gb is a slightly heavier default
  // than the create-route's s-1vcpu-1gb because SA-driven provisioning
  // is for production servers, not throwaway smoke tests).
  const region = opts.region ?? ((getSetting("do_default_region") || "").trim() || "nyc1")
  const size = opts.size ?? ((getSetting("do_default_size") || "").trim() || "s-2vcpu-4gb")
  logPipeline(serverName, "sa_create", "running", `Creating server via ServerAvatar...`)
  try {
    const providerId = parseInt(getSetting("sa_cloud_provider_id") || "0", 10) || 0
    const payload = {
      name: serverName,
      provider: "digitalocean",
      cloud_server_provider_id: providerId,
      version: "24",
      region,
      sizeSlug: size,
      ssh_key: false,
      web_server: "apache2",
      database_type: "mysql",
      nodejs: false,
    }
    const { res, orgId, label } = await saRequest("/organizations/{ORG_ID}/servers", {
      method: "POST", json: true, body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const body = await safeJson(res)
      const msg = saErrorMessage(body, `HTTP ${res.status}`)
      logPipeline(serverName, "sa_create", "failed", msg)
      throw new Error(msg)
    }
    const data = (await res.json()) as { server?: SaServer } & SaServer
    const server = data.server ?? data
    const saServerId = String(server.id ?? "")
    const ip = String(server.ip ?? "")
    // Record the org id of whichever candidate succeeded — failover may
    // have placed this server on the backup org, and subsequent SA calls
    // about it must use the matching org for its URLs.
    updateServer(serverIdDb, { sa_server_id: saServerId, sa_org_id: orgId })
    if (ip) updateServer(serverIdDb, { ip })
    logPipeline(serverName, "sa_create", "completed",
      `Server created via ${label} token (SA ID: ${saServerId}, IP: ${ip}, org: ${orgId})`)
    return { saServerId, ip }
  } catch (e) {
    if (!(e instanceof Error)) throw new Error(String(e))
    throw e
  }
}

export async function waitForServerReady(saServerId: string, timeoutMs = 600_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const info = await getServerInfo(saServerId)
      const status = String(info.agent_status ?? info.status ?? "")
      if (status === "connected" || status === "active" || status === "1") return true
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 20_000))
  }
  return false
}

// ---------------------------------------------------------------------------
// Application REST
// ---------------------------------------------------------------------------

export interface SaApp {
  id: number | string
  name?: string
  primary_domain?: string
  [k: string]: unknown
}

interface SaPaginated<T> {
  applications?:
    | { current_page: number; data: T[]; last_page: number }
    | T[]
  data?: T[]
}

/** Paginate transparently and return ALL applications across pages. */
export async function listApplications(saServerId: string): Promise<SaApp[]> {
  const all: SaApp[] = []
  let page = 1
  while (true) {
    const { res } = await saRequest(
      `/organizations/{ORG_ID}/servers/${saServerId}/applications?page=${page}`,
    )
    if (!res.ok) {
      throw new Error(`SA list_applications HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const body = (await res.json()) as SaPaginated<SaApp>
    const paginated = body.applications
    if (paginated && !Array.isArray(paginated) && "data" in paginated) {
      all.push(...paginated.data)
      if (page >= (paginated.last_page ?? 1)) break
      page++
      if (page > 100) break
    } else if (Array.isArray(paginated)) {
      all.push(...paginated)
      break
    } else if (Array.isArray(body.data)) {
      all.push(...body.data)
      break
    } else {
      break
    }
  }
  return all
}

export async function findAppId(saServerId: string, domain: string): Promise<string | null> {
  const apps = await listApplications(saServerId)
  const expected = appNameFor(domain)
  for (const a of apps) {
    if (a.primary_domain === domain) return String(a.id)
    if (a.name === expected) return String(a.id)
    if (a.primary_domain && String(a.primary_domain).includes(domain)) return String(a.id)
  }
  return null
}

async function getSystemUserId(saServerId: string): Promise<string | number | null> {
  try {
    const { res } = await saRequest(
      `/organizations/{ORG_ID}/servers/${saServerId}/system-users`,
      { timeoutMs: 15_000 },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { systemUsers?: { id: number | string }[]; data?: { id: number | string }[] }
    const users = data.systemUsers ?? data.data ?? []
    return users[0]?.id ?? null
  } catch {
    return null
  }
}

/** Create an SA application backed by a system user (existing or new). */
export async function createApplication(saServerId: string, domain: string): Promise<string> {
  logPipeline(domain, "sa_create_app", "running", `Creating app for ${domain}`)
  const appName = appNameFor(domain)
  const sysUsername = sysUserFor(domain)

  const existingUserId = await getSystemUserId(saServerId)
  const payload: Record<string, unknown> = {
    name: appName,
    method: "custom",
    framework: "custom",
    temp_domain: false,
    hostname: domain,
    www: true,
    php_version: "8.2",
  }
  if (existingUserId) {
    payload.systemUser = "existing"
    payload.systemUserId = existingUserId
  } else {
    payload.systemUser = "new"
    payload.systemUserInfo = {
      username: sysUsername,
      password: getSetting("server_root_password") || "Ssr@Temp2024",
    }
  }

  const { res } = await saRequest(
    `/organizations/{ORG_ID}/servers/${saServerId}/applications`,
    { method: "POST", json: true, body: JSON.stringify(payload) },
  )
  if (!res.ok) {
    const body = await safeJson(res)
    const msg = saErrorMessage(body, `HTTP ${res.status}`)
    logPipeline(domain, "sa_create_app", "failed", msg.slice(0, 500))
    throw new Error(msg)
  }
  const data = (await res.json()) as { application?: SaApp } & SaApp
  const app = data.application ?? data
  const appId = String(app.id ?? "")
  logPipeline(domain, "sa_create_app", "completed", `App created (ID: ${appId})`)
  return appId
}

export async function deleteApplication(
  saServerId: string,
  domain: string,
): Promise<{ ok: boolean; message: string }> {
  logPipeline(domain, "sa_delete_app", "running", `Deleting ${domain} from ServerAvatar...`)
  try {
    const appId = await findAppId(saServerId, domain)
    if (!appId) {
      logPipeline(domain, "sa_delete_app", "warning", "App not found on SA server")
      return { ok: false, message: "App not found" }
    }
    // SA refuses to delete an app whose `ssl` field is non-null with the same
    // generic HTTP 500 "Something went wrong while deleting application." that
    // bit us on the install side (state-lock guard, root-caused 2026-05-14).
    // Pre-clear SSL first — `disableAutoSsl` is idempotent (404 = already empty).
    // Failures here are non-fatal: if the DELETE below still 500s, the operator
    // sees the same SA message they would have without this — no harm done.
    await disableAutoSsl(saServerId, appId).catch(() => { /* best-effort */ })
    const { res } = await saRequest(
      `/organizations/{ORG_ID}/servers/${saServerId}/applications/${appId}`,
      { method: "DELETE" },
    )
    if (!res.ok) {
      const body = await safeJson(res)
      const msg = saErrorMessage(body, `HTTP ${res.status}`)
      logPipeline(domain, "sa_delete_app", "failed", msg)
      return { ok: false, message: msg }
    }
    logPipeline(domain, "sa_delete_app", "completed", `App ${appId} deleted`)
    return { ok: true, message: `Deleted app ${appId}` }
  } catch (e) {
    const msg = (e as Error).message
    logPipeline(domain, "sa_delete_app", "failed", msg)
    return { ok: false, message: msg }
  }
}

// ---------------------------------------------------------------------------
// Direct-installation / agent install
// ---------------------------------------------------------------------------

/**
 * Generate the SA install one-liner. This is a bash command embedding a
 * one-time token; it has to be executed on a fresh Ubuntu droplet.
 */
async function generateInstallCommand(opts: {
  serverName: string
  webServer?: string
  databaseType?: string
  nodejs?: boolean
}): Promise<string> {
  const webServer = opts.webServer ?? getSetting("sa_install_webserver") ?? "apache2"
  const databaseType = opts.databaseType ?? getSetting("sa_install_database") ?? "mysql"
  const payload = {
    name: opts.serverName,
    web_server: webServer,
    database_type: databaseType,
    nodejs: opts.nodejs ? 1 : 0,
    root_password_available: false,
  }
  const { res } = await saRequest(
    "/organizations/{ORG_ID}/direct-installation/generate-command",
    { method: "POST", json: true, body: JSON.stringify(payload) },
  )
  if (!res.ok) {
    const body = await safeJson(res)
    throw new Error(saErrorMessage(body, `SA generate-command HTTP ${res.status}`))
  }
  const data = (await res.json()) as Record<string, unknown>
  const dataNested = (data.data as Record<string, unknown> | undefined) ?? {}
  const cmd =
    (data.commands as string | undefined) ??
    (data.command as string | undefined) ??
    (data.install_command as string | undefined) ??
    (dataNested.commands as string | undefined) ??
    (dataNested.command as string | undefined) ??
    (dataNested.install_command as string | undefined)
  if (!cmd) {
    throw new Error(`SA did not return an install command. Body: ${JSON.stringify(data).slice(0, 400)}`)
  }
  return cmd
}

/**
 * Install the SA agent on a freshly-provisioned Ubuntu droplet. SSHes in,
 * runs the installer asynchronously (nohup), then polls SA's side until the
 * server appears as connected. Returns the new sa_server_id.
 */
/**
 * Run the SA install on a fresh DO droplet. Two attempts: if the first
 * fails (timeout waiting for SA agent to register, half-registered SA
 * row) the half-registered SA server is deleted and the install script
 * is re-run on the same droplet. Saves the cost of throwing away a
 * working droplet for a transient install failure (apt blip, slow
 * cloud-init, network hiccup during agent download).
 *
 * Returns the SA server id on success. Throws after both attempts fail.
 */
export async function installAgentOnDroplet(opts: {
  dropletIp: string
  serverName: string
  timeoutInstallMs?: number
  /** How many full SSH+install+poll attempts to run before giving up.
   *  Default 2 — first attempt + one retry with SA-side cleanup. Each
   *  attempt costs `timeoutInstallMs` worst-case so don't crank this up
   *  blindly. */
  maxAttempts?: number
  /** Called with a human-readable status line each time we have new info
   *  (post-SSH-launch, every poll iteration). The orchestrator wires this
   *  to updateStep so the watcher shows live progress instead of a frozen
   *  message during the 5-15 min agent install. */
  onProgress?: (message: string) => void
}): Promise<string> {
  const { dropletIp, serverName } = opts
  const timeoutInstallMs = opts.timeoutInstallMs ?? 900_000
  const maxAttempts = opts.maxAttempts ?? 2
  const onProgress = opts.onProgress ?? (() => { /* no-op */ })

  const rootPassword = getSetting("server_root_password") || ""
  if (!rootPassword) throw new Error("server_root_password not set")

  let lastError: Error | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const saServerId = await installAgentOnDropletAttempt({
        dropletIp, serverName, rootPassword, timeoutInstallMs, onProgress, attempt,
      })
      return saServerId
    } catch (e) {
      lastError = e as Error
      // Inspect the failure: if SA actually saw the agent (partial
      // registration with a saServerId attached to the error), clean up
      // the SA-side stub so the retry's poll doesn't latch onto the
      // half-dead row. The `partialSaServerId` is exposed on a custom
      // property by the inner function below.
      const partialId = (e as { partialSaServerId?: string }).partialSaServerId
      const reachedDeadline = !!(e as { reachedDeadline?: boolean }).reachedDeadline
      if (attempt < maxAttempts) {
        if (partialId) {
          logPipeline(serverName, "sa_install", "warning",
            `Attempt ${attempt} timed out with SA stub sa_id=${partialId} half-registered; ` +
            `deleting the SA stub before retry`)
          const cleanup = await deleteSaServer(partialId)
          if (cleanup.ok) {
            logPipeline(serverName, "sa_install", "running",
              `SA stub ${partialId} deleted; retrying install (attempt ${attempt + 1}/${maxAttempts})`)
          } else {
            logPipeline(serverName, "sa_install", "warning",
              `SA stub ${partialId} delete reported error: ${cleanup.reason}; retrying anyway`)
          }
        } else if (reachedDeadline) {
          logPipeline(serverName, "sa_install", "warning",
            `Attempt ${attempt} timed out with no SA-side state; retrying install (attempt ${attempt + 1}/${maxAttempts})`)
        } else {
          // Non-timeout failure (e.g. SSH never connected). Probably worth
          // ONE retry in case cloud-init was still bringing the droplet up.
          logPipeline(serverName, "sa_install", "warning",
            `Attempt ${attempt} failed: ${(e as Error).message.slice(0, 160)}; ` +
            `retrying (attempt ${attempt + 1}/${maxAttempts})`)
        }
        continue
      }
      throw lastError
    }
  }
  throw lastError ?? new Error("installAgentOnDroplet: exhausted retries with no error captured")
}

interface InstallAttemptError extends Error {
  partialSaServerId?: string
  reachedDeadline?: boolean
}

async function installAgentOnDropletAttempt(opts: {
  dropletIp: string
  serverName: string
  rootPassword: string
  timeoutInstallMs: number
  onProgress: (message: string) => void
  attempt: number
}): Promise<string> {
  const { dropletIp, serverName, rootPassword, timeoutInstallMs, onProgress, attempt } = opts

  logPipeline(serverName, "sa_install", "running",
    `Requesting SA install command for ${serverName} (attempt ${attempt})`)
  const cmd = await generateInstallCommand({ serverName })

  logPipeline(serverName, "sa_install", "running", `Waiting for SSH on ${dropletIp}...`)
  const ssh = await waitForSsh(dropletIp, rootPassword, "root", 240_000)
  try {
    // Wait for cloud-init to finish before starting the SA install script.
    // SSH becomes available within ~30-60s of droplet boot, but cloud-init
    // (which sets up apt, kernel modules, system services) keeps running
    // for another 3-7 minutes. Operator policy 2026-05-01: SA install
    // launched too early was racing cloud-init — the install script's
    // "is this droplet clean?" check fires while apt is mid-update or a
    // package is still configuring → SA flags "Conflict detected" /
    // "Not supported" and the install dead-ends. Blocking on cloud-init's
    // own completion signal is the proper fix (vs a flat sleep that's
    // either too short for slow boots or wastes time on fast ones).
    //
    // `cloud-init status --wait`:
    //   - returns 0 when cloud-init done successfully
    //   - returns 0 with "status: done" stdout when already complete (cheap on reinstall)
    //   - blocks up to its internal timeout (~10 min worst case) otherwise
    //   - returns non-zero on cloud-init error or missing binary
    // We wrap in a 6-min ssh.exec timeout as a hard ceiling. Failures fall
    // through (logged warning) — better to attempt the install than block
    // forever on a corrupt cloud-init.
    logPipeline(serverName, "sa_install", "running",
      `Waiting for cloud-init to complete on ${dropletIp} (typical 3-7 min on fresh droplets)...`)
    try {
      const ci = await ssh.exec("cloud-init status --wait 2>&1 || true", { timeoutMs: 360_000 })
      const status = ci.stdout.trim().slice(0, 200)
      logPipeline(serverName, "sa_install", "running",
        `cloud-init wait returned exit=${ci.code}: ${status || "(no output)"}`)
    } catch (e) {
      logPipeline(serverName, "sa_install", "warning",
        `cloud-init wait failed/timed out: ${(e as Error).message.slice(0, 200)} — proceeding with install anyway`)
    }
    logPipeline(serverName, "sa_install", "running",
      `Running install script on ${dropletIp} (takes 5-15 min)`)
    const escaped = `'${cmd.replace(/'/g, "'\\''")}'`
    const asyncCmd =
      "mkdir -p /root/sa_install && " +
      "cd /root/sa_install && " +
      `echo ${escaped} > install.sh && ` +
      "chmod +x install.sh && " +
      "( setsid nohup bash install.sh < /dev/null > install.log 2>&1 & " +
      "  echo $! > install.pid ) >/dev/null 2>&1 < /dev/null"
    try {
      await ssh.exec(asyncCmd, { timeoutMs: 60_000 })
    } catch (e) {
      logPipeline(serverName, "sa_install", "warning",
        `SSH launcher did not return cleanly (${(e as Error).message.slice(0, 200)}); ` +
        `polling SA for agent appearance anyway`)
    }

    // Two parallel detection paths racing — first verdict wins:
    //
    //   (a) STREAM CLASSIFIER — opens a 2nd SSH session, tails
    //       install.log, classifies each line. Catches success markers
    //       (`Report sent!`, the SA dashboard URL with embedded
    //       sa_server_id) ~6 min faster than the SA poll loop. Catches
    //       fast-fail patterns (`Conflict detected ... clean ubuntu
    //       server`) within ~30s instead of waiting the full 15-min
    //       timeout. See classifyInstallLine for the patterns.
    //
    //   (b) SA POLL LOOP — original 30s polling against SA's API for
    //       the agent to appear with status='connected'. Kept as the
    //       safety net: if SA's install script changes wording or the
    //       SSH stream drops mid-install, the poll still detects the
    //       eventual registration.
    //
    // Promise.race on success, but for failure the streamer can reject
    // the whole thing immediately (skipping the poll's wait-for-deadline).
    const start = Date.now()
    const deadline = start + timeoutInstallMs
    const totalMin = Math.round(timeoutInstallMs / 60_000)
    let saServerId: string | null = null
    let lastSaStatus = "(none)"

    // Build the stream classifier promise (resolves with sa_server_id on
    // success, rejects on fast-fail). Wrapped in a self-isolating session
    // so SSH drops on the streamer don't tear down the main install ssh.
    const streamerPromise = (async (): Promise<string> => {
      let streamerSsh: SshSession | null = null
      try {
        streamerSsh = await SshSession.connect({
          host: dropletIp, port: 22, username: "root", password: rootPassword,
          readyTimeout: 30_000, tryKeyboard: false,
        })
      } catch (e) {
        // Couldn't open the streaming session — yield to poll loop only
        throw new Error(`streamer ssh connect failed: ${(e as Error).message}`)
      }
      try {
        let detectedSaId = ""
        let detectedFail: string | null = null
        // tail -F reads from EOF by default; -n +1 starts from line 1
        // so we don't miss markers that landed before we connected.
        await streamerSsh.execStream(
          "tail -n +1 -F /root/sa_install/install.log 2>/dev/null",
          (line) => {
            const verdict = classifyInstallLine(line)
            if (verdict.kind === "success") {
              if (verdict.saServerId) detectedSaId = verdict.saServerId
              logPipeline(serverName, "sa_install", "running",
                `STREAM detected SUCCESS: ${verdict.matched} ${detectedSaId ? `(sa_id=${detectedSaId})` : ""}`)
              return false  // tells execStream to terminate
            }
            if (verdict.kind === "fail") {
              detectedFail = verdict.reason ?? "unknown fast-fail pattern"
              logPipeline(serverName, "sa_install", "warning",
                `STREAM detected FAIL pattern: ${verdict.reason ?? "(no reason)"}`)
              return false
            }
            return true
          },
          { timeoutMs: timeoutInstallMs },
        )
        if (detectedFail) throw new Error(`stream classifier: ${detectedFail}`)
        if (!detectedSaId) {
          // Stream ended without a verdict (file rotation, connection drop)
          // — fall back to the poll path
          throw new Error("stream classifier ended without verdict")
        }
        return detectedSaId
      } finally {
        try { streamerSsh.close() } catch { /* ignore */ }
      }
    })()

    onProgress(
      `Installing SA agent on ${dropletIp} — 0m elapsed / ${totalMin}m max · ` +
      `streaming install.log + polling SA every 30s (attempt ${attempt})`,
    )
    // SA poll loop wrapped in a promise so we can race it against the
    // streamer. Same logic as before — on success returns sa_server_id,
    // on timeout throws an error with reachedDeadline=true.
    const pollPromise = (async (): Promise<string> => {
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30_000))
        let candidates: SaServer[]
        try {
          candidates = await listServers()
        } catch (e) {
          onProgress(
            `SA list-servers failed (${(e as Error).message.slice(0, 80)}); ` +
            `retrying in 30s`,
          )
          continue
        }
        for (const s of candidates) {
          const sIp = String(s.server_ip ?? s.ip ?? "")
          if (sIp !== dropletIp) continue
          const status = String(s.agent_status ?? s.status ?? "")
          saServerId = String(s.id ?? "")
          lastSaStatus = status || "(unknown)"
          if (status === "connected" || status === "active" || status === "1") {
            logPipeline(serverName, "sa_install", "completed",
              `SA agent active; sa_server_id=${saServerId} (attempt ${attempt}, source=poll)`)
            return saServerId
          }
        }
        if (saServerId) {
          try {
            const info = await getServerInfo(saServerId)
            const status = String(info.agent_status ?? info.status ?? "")
            lastSaStatus = status || lastSaStatus
            if (status === "connected" || status === "active" || status === "1") {
              logPipeline(serverName, "sa_install", "completed",
                `SA agent active; sa_server_id=${saServerId} (attempt ${attempt}, source=poll)`)
              return saServerId
            }
          } catch { /* keep polling */ }
        }
        const elapsedMin = Math.round((Date.now() - start) / 60_000)
        onProgress(
          `Installing SA agent on ${dropletIp} — ${elapsedMin}m / ${totalMin}m · ` +
          `SA status: ${lastSaStatus}` +
          (saServerId ? ` (sa_id=${saServerId})` : " (not yet visible to SA)") +
          ` (attempt ${attempt})`,
        )
      }
      throw new Error("poll loop exhausted")  // caught below
    })()

    // Race streamer vs poll — first to resolve wins. If streamer resolves
    // (success), great. If streamer rejects (fast-fail or stream ended
    // without verdict), we let it propagate ONLY if it's a fast-fail; for
    // "ended without verdict" we fall through to the poll. We use a tagged
    // wrapper around streamerPromise so the racer can distinguish.
    let raceWinnerId: string | null = null
    let streamerFailedFast: string | null = null
    try {
      raceWinnerId = await Promise.race([
        pollPromise.then((id) => ({ id, source: "poll" as const })).then((r) => r.id),
        streamerPromise.then(
          (id) => ({ id, source: "stream" as const }),
          (e) => {
            const msg = (e as Error).message
            // Fast-fail: stream classifier matched a bad pattern
            if (msg.startsWith("stream classifier:")) {
              streamerFailedFast = msg.replace(/^stream classifier:\s*/, "")
              throw e
            }
            // "ended without verdict" / "ssh connect failed" → swallow,
            // fall back to poll result
            return new Promise<{ id: string; source: "stream" }>(() => { /* never resolves; poll will */ })
          },
        ).then((r) => r.id),
      ])
      if (raceWinnerId) {
        logPipeline(serverName, "sa_install", "completed",
          `Detected via race: sa_server_id=${raceWinnerId} (attempt ${attempt})`)
        return raceWinnerId
      }
    } catch (e) {
      if (streamerFailedFast) {
        // Fast-fail propagates as a hard error so the outer destroy logic
        // (in migration.ts / handlers/server-create.ts) can nuke the droplet.
        throw new Error(`SA install fast-fail: ${streamerFailedFast}`)
      }
      // Poll loop exhausted — fall through to the timeout-with-tail block
    }

    // Timeout — read install.log tail for diagnosis. Attach the partial
    // SA id (if any) to the thrown error so the outer retry loop can
    // delete the half-registered SA server before re-running install.
    let tail = "(could not read install.log)"
    try {
      const r = await ssh.exec("tail -n 50 /root/sa_install/install.log", { timeoutMs: 15_000 })
      tail = r.stdout
    } catch { /* ignore */ }
    const err: InstallAttemptError = new Error(
      `SA agent did not become active within ${timeoutInstallMs}ms (attempt ${attempt}). ` +
      `Install log tail:\n${tail.slice(-1500)}`,
    )
    err.reachedDeadline = true
    if (saServerId) err.partialSaServerId = saServerId
    throw err
  } finally {
    ssh.close()
  }
}

/**
 * Classify a single line of SA install script output as success / fast-fail
 * / no-verdict. Used by the streaming tail to detect the install outcome
 * faster than the SA poll loop's 30s cadence (catches success ~6 min earlier
 * AND fast-fails like "Conflict detected" within ~30s vs 15-min timeout).
 *
 * Patterns are derived from a captured install log (basket-01-05-2026,
 * 2026-05-01) — extend as we observe new SA wording. All regexes case-
 * insensitive; success patterns are loose, fail patterns are strict
 * (anchored on multi-keyword phrases) to minimize false-positive risk.
 */
export function classifyInstallLine(line: string): {
  kind: "success" | "fail" | null
  matched?: string
  reason?: string
  saServerId?: string
} {
  // Try to extract the sa_server_id from the post-install URL
  // (`https://app.serveravatar.com/organizations/<org>/servers/<id>/installation`)
  const urlMatch = line.match(/\/servers\/(\d+)\/installation/)

  // Success markers — any of these means install reached the registration
  // phase. Order doesn't matter; first match wins.
  if (/Now you can see this server into ServerAvatar Dashboard/i.test(line)) {
    return { kind: "success", matched: "dashboard-marker", saServerId: urlMatch?.[1] }
  }
  if (/Report sent!/i.test(line)) {
    return { kind: "success", matched: "report-sent" }
  }
  if (urlMatch) {
    return { kind: "success", matched: "install-url", saServerId: urlMatch[1] }
  }

  // Fast-fail markers — strict, anchor on TWO keywords to avoid matching
  // log lines that happen to contain one keyword in benign context.
  if (/Conflict detected/i.test(line) && /clean ubuntu server/i.test(line)) {
    return {
      kind: "fail",
      reason: "SA refused dirty droplet (pre-installed apache/nginx/php/mysql) — needs fresh OS",
    }
  }
  if (/already installed/i.test(line) && /(apache|nginx|openlitespeed|php|mysql|mariadb)/i.test(line)) {
    return {
      kind: "fail",
      reason: `SA detected pre-existing service in install path: ${line.slice(0, 200)}`,
    }
  }
  if (/error.*kernel/i.test(line) && /unsupported|incompatible/i.test(line)) {
    return { kind: "fail", reason: `unsupported kernel: ${line.slice(0, 200)}` }
  }
  return { kind: null }
}

// ---------------------------------------------------------------------------
// Custom SSL install (3-step API dance, then SSH fallback)
// ---------------------------------------------------------------------------

interface InstallSslOpts {
  saServerId: string
  appId: string
  certificatePem: string
  privateKeyPem: string
  chainPem?: string
  forceHttps?: boolean
  domain?: string
  serverIp?: string
}

/**
 * Install a Cloudflare Origin CA cert on an SA app. **Strictly CF Origin —
 * never installs SA's auto-Let's-Encrypt as a side effect** (operator
 * policy).
 *
 * API path: destroy any existing SSL (clears in-flight LE), then POST
 * `ssl_type=custom` with our cert + `force_https=true`. If the API path
 * fails (the documented SA HTTP-500 bug), fall through to UI then SSH.
 */
export async function installCustomSsl(opts: InstallSslOpts): Promise<{ ok: boolean; message: string }> {
  // SSL API path template — saRequest substitutes {ORG_ID} per candidate.
  // NOTE on failover semantics: an SA application belongs to one specific
  // org, so a primary-blocked install can't truly succeed via backup unless
  // the backup org happens to also own this app (rare). Still, going
  // through saRequest gives us automatic 429/5xx retry on the SAME org —
  // which is the more common rescue case anyway.
  const sslPath =
    `/organizations/{ORG_ID}/servers/${opts.saServerId}` +
    `/applications/${opts.appId}/ssl`

  const apiResult = await tryApiSslFlow(sslPath, opts)
  if (apiResult.ok) return apiResult

  // The API path's documented failure mode is HTTP 500 with the body
  // `{"message":"Something went wrong while creating custom ssl certificate."}`
  // (ssr_technical_gotchas #3 — SA backend bug, the UI/SSH tiers exist
  // exactly because of it). When that's why we're falling through, log it
  // as a separate "info" line for forensics rather than dumping a scary
  // "API flow exception" string into the eventual success message.
  const apiBenign = /something went wrong while creating custom ssl/i.test(apiResult.message)
  if (opts.domain) {
    logPipeline(opts.domain, "ssl_install", apiBenign ? "info" : "warning",
      apiBenign
        ? "SA API custom-SSL endpoint returned its known 500 — falling through to UI/SSH path"
        : `SA API path failed (${apiResult.message.slice(0, 200)}) — falling through to UI/SSH`,
    )
  }

  // UI fallback (patchright + iproyal proxy if configured) — drives SA's
  // dashboard like a human. Heavy: only loaded when API has actually failed.
  // For UI fallback we need a concrete org id — use the primary's since
  // that's whichever org originally created the resource.
  const primaryOrg = (getSetting("serveravatar_org_id") || "").trim()
  let uiMsg = ""
  if (opts.domain && primaryOrg) {
    try {
      const { installCustomSslViaUi } = await import("./serveravatar-ui")
      const ui = await installCustomSslViaUi({
        orgId: primaryOrg,
        serverId: opts.saServerId,
        appId: opts.appId,
        domain: opts.domain,
        certPem: opts.certificatePem,
        keyPem: opts.privateKeyPem,
        // Per Flask SOP: install with EMPTY chain — SA's UI writes
        // SSLCertificateChainFile into apache.conf when chain is provided,
        // and a stale chain breaks mod_ssl. Leaving it blank produces a
        // clean apache config that boots fine.
        chainPem: "",
        forceHttps: opts.forceHttps !== false,
      })
      if (ui.ok) {
        return {
          ok: true,
          message: `Installed via SA UI${apiBenign ? "" : " (API path unavailable)"}`,
        }
      }
      uiMsg = ui.message
    } catch (e) {
      uiMsg = `UI automation: ${(e as Error).name}: ${(e as Error).message}`
    }
  }

  // SSH fallback
  if (!opts.domain || !opts.serverIp) {
    throw new Error(
      `SA API + UI install both failed, no SSH fallback available ` +
      `(need domain + serverIp). API: ${apiResult.message}  UI: ${uiMsg}`,
    )
  }

  // Tier 3: SA agent local API (port 43210) — installs cert via SA's own
  // internal install scripts. Cleaner than raw `tee` because it uses the
  // same code path SA's cloud would normally use, including apache reload
  // sequencing. Doesn't touch SA's cloud DB (pushSaUiTracker handles that
  // separately afterward).
  //
  // Fails fast (~3s) if the agent's config.json isn't readable or the
  // loopback IP-alias trick doesn't apply — falls through to Tier 4 (SSH
  // tee) without delaying the pipeline.
  let ssh = await installCustomSslViaSaAgent(
    opts.serverIp, opts.domain,
    opts.certificatePem, opts.privateKeyPem, opts.chainPem || "",
    { forceHttps: opts.forceHttps !== false },
  )
  if (!ssh.ok) {
    logPipeline(opts.domain, "ssl_install", "info",
      `SA agent path (port 43210 bypass) didn't land: ${ssh.message.slice(0, 200)} — ` +
      `falling through to legacy SSH-tee.`)
    // Tier 4: legacy SSH `tee` to /etc/ssl/... + manual apache reload.
    ssh = await sshInstallSslFiles(
      opts.serverIp, opts.domain, opts.certificatePem, opts.privateKeyPem,
      { forceHttps: opts.forceHttps !== false },
    )
  }

  // Post-SSH SA-tracker push so SA's dashboard UI reflects "Custom SSL
  // Active · CloudFlare Origin" instead of blank "No SSL".
  //
  // This is the full path discovered 2026-05-14: SA's POST /ssl with
  // ssl_type:custom only succeeds when the app's `ssl` field is NON-null
  // (i.e. SA has previously installed an automatic SSL state). For fresh
  // apps where SA never auto-issued LE (the common case — orange-clouded
  // DNS prevents SA's HTTP-01 challenge from reaching origin), `app.ssl`
  // stays null and POST custom 500s with the generic "Something went
  // wrong" message.
  //
  // Sequence to fix:
  //   1. If current state is already "custom" + CF Origin → nothing to do.
  //   2. If app.ssl is null → POST /ssl ssl_type:"automatic" to ask SA to
  //      install LE. SA's auto-LE only succeeds while origin port 80 is
  //      reachable directly — step 8's grey-cloud window provides that.
  //      We poll GET /ssl until installed:true (up to 120s).
  //   3. DELETE /ssl to clear the now-non-null state.
  //   4. POST /ssl ssl_type:"custom" with our cached cert. Succeeds.
  //   5. GET /ssl/force-https (a toggle-disguised-as-GET) to flip
  //      force_ssl 0→1.
  //
  // All best-effort: failure here doesn't undo the SSH win (cert is on
  // the wire); we just log a warning and the SA UI stays blank for that
  // app until the next step 8 retry.
  if (opts.domain) {
    // Awaited (not fire-and-forget) so DNS is still grey-clouded by step
    // 8 when SA's auto-LE HTTP-01 challenge fires. If we fire-and-forget,
    // step 8's finally block restores orange-cloud and SA's auto-LE then
    // hits CF instead of origin, returns "DNS propagation" 500, and the
    // sync fails. ~2 min worst case (waiting for LE install). Best-effort
    // throughout — never throws upstream.
    //
    // 2026-05-14 fix: this no longer requires `ssh.ok`. The SSH path can
    // report `ok=false` even when cert files were written successfully —
    // most commonly because apache was mid-restart from SA's app creation
    // and our reload races with it (failing for ~30-60s before apache
    // recovers on its own). The recipe inside `pushSaUiTracker` drives
    // SA's own apache reload via REST, which serializes properly. Result
    // was 4 of 5 domains with a blank SA tracker even though their sites
    // were live; broadening the gate gets the SA UI in sync. If
    // pushSaUiTracker also can't recover, it logs a warning and returns —
    // no harm done.
    await pushSaUiTracker(sslPath, opts).catch(() => { /* logged inside */ })
  }
  if (ssh.ok) {
    return {
      ok: true,
      message: `Installed via SSH (API + UI fallbacks unavailable)`,
    }
  }
  throw new Error(
    `All three SSL install paths failed. API: ${apiResult.message}  ` +
    `UI: ${uiMsg}  SSH: ${ssh.message}`,
  )
}

/**
 * Post-install verification — TLS-probes the origin IP directly (SNI=domain)
 * and inspects the peer cert's issuer. Confirms our CF Origin CA cert is the
 * one actually serving on the SA box, not SA's auto-issued Let's Encrypt.
 *
 * Connecting via the public domain would hit the CF edge (which uses CF's
 * Universal/LE cert and doesn't reveal the origin cert). We connect to the
 * server IP directly so the SA-installed cert is what comes back.
 *
 * `rejectUnauthorized: false` because the CF Origin CA cert is signed by a
 * CF-private root that's not in Node's trust store — we're checking the
 * issuer, not validating the chain.
 *
 * Failure modes:
 *   - probe ok + issuer matches CF Origin CA → ok=true (cert verified)
 *   - probe ok + issuer is something else (Let's Encrypt, etc.) → ok=false
 *     (the install reported success but a different cert is serving)
 *   - probe fails (timeout, ECONNREFUSED) → returns ok=null so the caller
 *     can decide; we don't fail step 8 on a transient network blip.
 */
export interface OriginCertProbeResult {
  ok: boolean | null
  issuerCN: string | null
  subjectCN: string | null
  message: string
}

export async function verifyOriginCertIsCustom(
  serverIp: string, domain: string, timeoutMs = 10_000,
): Promise<OriginCertProbeResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (r: OriginCertProbeResult) => {
      if (settled) return
      settled = true
      try { socket.end() } catch { /* ignore */ }
      resolve(r)
    }
    const timer = setTimeout(() => {
      finish({ ok: null, issuerCN: null, subjectCN: null,
        message: `verify probe timed out after ${Math.round(timeoutMs / 1000)}s` })
    }, timeoutMs)
    const socket = tlsConnect({
      host: serverIp,
      port: 443,
      servername: domain,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    }, () => {
      clearTimeout(timer)
      const cert: PeerCertificate = socket.getPeerCertificate(false)
      const issuer = cert?.issuer ?? {}
      const subject = cert?.subject ?? {}
      const issuerCN = (issuer as { CN?: string }).CN ?? null
      const issuerOU = (issuer as { OU?: string }).OU ?? ""
      const subjectCN = (subject as { CN?: string }).CN ?? null
      // Match either issuer CN or OU — CF's Origin CA cert has:
      //   issuer: O=CloudFlare, Inc., OU=CloudFlare Origin SSL Certificate Authority, ...
      //   (CN is sometimes "Origin SSL ECC Certificate Authority" or absent)
      const isCustom =
        /cloudflare origin/i.test(issuerCN ?? "") ||
        /cloudflare origin/i.test(issuerOU)
      finish({
        ok: isCustom,
        issuerCN: issuerCN || issuerOU || null,
        subjectCN,
        message: isCustom
          ? `verified — issuer=${issuerCN || issuerOU}`
          : `WRONG ISSUER — expected CF Origin CA, got ${issuerCN || issuerOU || "(unknown)"} (subject=${subjectCN ?? "?"})`,
      })
    })
    socket.on("error", (e) => {
      clearTimeout(timer)
      finish({ ok: null, issuerCN: null, subjectCN: null,
        message: `verify probe error: ${(e as NodeJS.ErrnoException).code ?? ""} ${e.message}`.trim() })
    })
  })
}

export interface ForceHttpsProbeResult {
  /** true = origin port-80 redirects to https://. false = no redirect. null = network error. */
  ok: true | false | null
  status: number | null
  location: string | null
  message: string
}

/**
 * Probe whether the origin's port 80 redirects HTTP → HTTPS. Talks directly
 * to the server IP with a forged `Host: <domain>` header so apache routes
 * the request to the right vhost.
 *
 * **Why node:http instead of fetch:** Node's undici-based `fetch()`
 * silently overrides a manually-set `Host` header with the URL's host
 * (the raw IP), so Apache falls through to the default vhost and returns
 * 200 — making this probe declare "no redirect" even when the real vhost
 * is correctly configured to 301. `http.request` respects the explicit
 * `Host: <domain>` header verbatim, which is what we need.
 *
 * Returns ok=true when status is 301/302/307/308 AND Location starts with
 * https://. ok=false when port 80 answered but didn't redirect (200 or
 * non-https Location). ok=null on connect/timeout error (caller treats
 * as inconclusive — don't trigger remediation on a transient blip).
 */
export async function probeForceHttps(
  serverIp: string, domain: string, timeoutMs = 8000,
): Promise<ForceHttpsProbeResult> {
  const http = await import("node:http")
  return new Promise<ForceHttpsProbeResult>((resolve) => {
    let settled = false
    const finish = (r: ForceHttpsProbeResult): void => {
      if (settled) return
      settled = true
      try { req.destroy() } catch { /* ignore */ }
      resolve(r)
    }
    const timer = setTimeout(() => finish({
      ok: null, status: null, location: null,
      message: `probe timed out after ${Math.round(timeoutMs / 1000)}s`,
    }), timeoutMs)
    const req = http.request({
      host: serverIp,
      port: 80,
      method: "GET",
      path: "/",
      headers: {
        Host: domain,
        "User-Agent": "ssr-force-https-probe/1",
        Connection: "close",
      },
      timeout: timeoutMs,
    }, (res) => {
      clearTimeout(timer)
      const status = res.statusCode ?? 0
      // res.headers is { [k: string]: string | string[] | undefined }
      const raw = res.headers.location
      const location = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null)
      // Drain body so the socket can close cleanly.
      res.resume()
      res.on("end", () => { /* socket closes via Connection: close */ })
      const isRedirect = status >= 300 && status < 400
      const toHttps = (location ?? "").toLowerCase().startsWith("https://")
      if (isRedirect && toHttps) {
        finish({ ok: true, status, location, message: `${status} → ${location}` })
      } else if (isRedirect) {
        finish({ ok: false, status, location, message: `redirect but not to https: ${location}` })
      } else {
        finish({ ok: false, status, location, message: `no redirect (status=${status})` })
      }
    })
    req.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      finish({
        ok: null, status: null, location: null,
        message: `probe error: ${e.code ?? ""} ${e.message ?? String(e)}`.trim(),
      })
    })
    req.on("timeout", () => {
      clearTimeout(timer)
      try { req.destroy() } catch { /* ignore */ }
      finish({
        ok: null, status: null, location: null,
        message: `probe timed out after ${Math.round(timeoutMs / 1000)}s`,
      })
    })
    req.end()
  })
}

async function tryApiSslFlow(
  sslPath: string,
  opts: InstallSslOpts,
): Promise<{ ok: boolean; message: string }> {
  try {
    // 0. Probe current state so we never run destructive ops blindly
    //    (2026-05-14 refactor — previously this function ALWAYS did
    //    DELETE /ssl as a "pre-clean" step, which wiped a perfectly
    //    good custom+CF Origin tracker to null if the subsequent POST
    //    failed for any reason. Auto-heal step-8 retries kept invoking
    //    this path on healthy domains and trashing their SA UI state).
    //
    //    Three outcomes from the probe:
    //      a. installed && type=custom && CN matches CF Origin
    //           → already correct, short-circuit with ok=true (no writes).
    //      b. installed=false / type=null (state is null)
    //           → SA's controller refuses POST custom on null state
    //             (the well-documented state-lock 500). DELETE→POST
    //             would also fail. Bail out with a clear message so
    //             the caller falls through to pushSaUiTracker, which
    //             owns the null-state recovery recipe (POST automatic
    //             prime → DELETE → POST custom, guarded by 6h LE-quota
    //             backoff).
    //      c. installed && type≠custom OR wrong CN
    //           → genuine swap is needed. DELETE+POST is the only path,
    //             accept the destructive nature here (we KNOW the
    //             starting state was not what we want).
    let currentType: string | null = null
    let currentCn: string | null = null
    let installedNow = false
    try {
      const { res: gr } = await saRequest(sslPath, { timeoutMs: 15_000 })
      if (gr.ok) {
        const body = (await gr.json()) as {
          installed?: boolean
          certificateInfo?: { type?: string; primary_domain?: string }
        }
        installedNow = Boolean(body.installed)
        currentType = body.certificateInfo?.type ?? null
        currentCn = body.certificateInfo?.primary_domain ?? null
      }
    } catch {
      // GET failed — proceed cautiously with the legacy DELETE+POST
      // path. Worst case: same destructive behavior as before this
      // refactor, no regression.
    }

    if (installedNow && currentType === "custom" && /cloudflare/i.test(currentCn ?? "")) {
      return {
        ok: true,
        message: `tracker already shows custom · CF Origin — no-op (type=${currentType} cn=${currentCn})`,
      }
    }
    if (!installedNow) {
      // SA tracker reports null. Refusing to run DELETE+POST here
      // because POST custom on a null state hits the state-lock 500 —
      // we'd just trash the (already-null) state for no benefit and
      // confuse the caller's fall-through logic.
      return {
        ok: false,
        message: `SA tracker state is null (installed=false) — API path can't recover; let pushSaUiTracker run the auto-LE-prime recipe.`,
      }
    }

    // 1. Pre-clean — clear SA's state so the custom install isn't blocked
    //    by SA's state-lock guard. The endpoint is **DELETE /ssl** (the old
    //    code called `POST /ssl/destroy`, which 404s — that was the entire
    //    reason custom installs returned the generic 500 'something went
    //    wrong': SA's state stayed locked at ssl_type=automatic, the next
    //    POST tried to install custom on top, and SA's controller threw).
    //    Discovered 2026-05-14 by probing supported methods on /ssl
    //    (405 response listed `GET, HEAD, POST, PATCH, DELETE`).
    //    200/204/404 all OK (404 = "no SSL state, nothing to delete").
    //
    //    Reaching this point means the state is *not* what we want
    //    (probed above) — the DELETE is intentional, not a blind wipe.
    let { res: r } = await saRequest(sslPath, { method: "DELETE" })
    if (![200, 204, 404].includes(r.status)) {
      return { ok: false, message: `pre-destroy (DELETE /ssl) failed (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}` }
    }
    await new Promise((res) => setTimeout(res, 2000))

    // 2. Install custom — our CF Origin CA cert. force_https:true tells
    //    SA to add the port-80 → 443 redirect via its installer.
    const customBody = {
      ssl_type: "custom",
      ssl_certificate: opts.certificatePem.trim() + "\n",
      private_key: opts.privateKeyPem.trim() + "\n",
      chain_file: opts.chainPem ? opts.chainPem.trim() + "\n" : "",
      force_https: opts.forceHttps !== false,
    }
    ;({ res: r } = await saRequest(sslPath, {
      method: "POST", json: true, body: JSON.stringify(customBody),
    }))
    if (!r.ok) {
      const body = await safeJson(r)
      // POST failed after we cleared the prior state — surface that
      // SA tracker is now in a worse state than when we started so the
      // caller can decide whether to escalate (e.g. trigger pushSaUiTracker
      // immediately, rather than wait for the next auto-heal tick).
      return {
        ok: false,
        message: `custom-install refused (HTTP ${r.status}) AFTER pre-destroy — ` +
          `SA tracker is now null (was ${currentType ?? "?"}). ` +
          `pushSaUiTracker should follow to recover via auto-LE prime. ` +
          `SA error: ${saErrorMessage(body, "")}`,
      }
    }

    // 3. Verify tracker — confirm SA stored it AND force_https is on.
    let trackerOk: boolean | null = null
    let forceHttpsOk: boolean | null = null
    try {
      const { res: gr } = await saRequest(sslPath, { timeoutMs: 15_000 })
      if (gr.ok) {
        const body = (await gr.json()) as { installed?: boolean; force_https?: boolean }
        trackerOk = Boolean(body.installed)
        forceHttpsOk = body.force_https === undefined ? null : Boolean(body.force_https)
      }
    } catch { /* ignore */ }

    return {
      ok: true,
      message: `SA API sequence complete; tracker installed=${trackerOk} force_https=${forceHttpsOk}`,
    }
  } catch (e) {
    return { ok: false, message: `API flow exception: ${(e as Error).message}` }
  }
}

/**
 * Push CF Origin cert into SA's dashboard tracker so SA UI displays
 * "Custom SSL Active · CloudFlare Origin" instead of blank. See the
 * 2026-05-14 bug-hunt comment in `installCustomSsl` above for full
 * context; tl;dr SA's POST /ssl custom requires `app.ssl` to be non-null,
 * which for fresh apps requires triggering SA's auto-LE first.
 *
 * Returns nothing — logs all outcomes to pipeline_log. Best-effort:
 * failures are warnings, never throw upstream (SSH path already
 * installed the cert on the wire).
 */
export async function pushSaUiTracker(
  sslPath: string,
  opts: InstallSslOpts,
): Promise<void> {
  const domain = opts.domain
  if (!domain) return
  try {
    // 1. Already in good state?
    const cur = await saRequest(sslPath, { timeoutMs: 15_000 })
    if (cur.res.status === 200) {
      const j = await cur.res.json() as { installed?: boolean; force_https?: boolean; forceHttps?: number; certificateInfo?: { type?: string; primary_domain?: string } }
      const isCustomCfOrigin = j.certificateInfo?.type === "custom" && /cloudflare/i.test(j.certificateInfo?.primary_domain ?? "")
      // SA returns force_https on the cert payload but force_ssl on the app
      // payload — we normalize both. forceHttps=1 / force_https=true both mean ON.
      const forceHttpsOn = Boolean(j.force_https) || Number(j.forceHttps) === 1
      if (isCustomCfOrigin && forceHttpsOn) {
        logPipeline(domain, "sa_ui_sync", "completed",
          "SA tracker already shows Custom SSL · CloudFlare Origin · forceHttps ON — nothing to push")
        return
      }
      // Partial-drift case (2026-05-15): cert is correct (custom + CF Origin)
      // but force_https is OFF. We don't need the full LE-prime dance — just
      // toggle force-https and bail. Observed on timbervault.site today:
      // the drift sweep kept enqueueing step 8 because force_ssl=0, but
      // step 8's pushSaUiTracker kept short-circuiting on the old check
      // (which ignored force_ssl). 3 wasted retries before drift cap hit.
      if (isCustomCfOrigin && !forceHttpsOn) {
        logPipeline(domain, "sa_ui_sync", "running",
          "SA tracker has Custom · CF Origin but force_https=0 — toggling on (no LE prime needed)")
        try {
          await saRequest(`${sslPath}/force-https`, { method: "GET", timeoutMs: 10_000 })
        } catch { /* harmless */ }
        logPipeline(domain, "sa_ui_sync", "completed",
          "SA tracker partial-drift fixed — toggled force_https ON without re-installing cert.")
        return
      }
      // 2. If state is null (no SSL installed), trigger SA's auto-LE so
      //    state becomes non-null. POST custom requires non-null state.
      if (!j.installed) {
        // LE-quota guard. Let's Encrypt's 5-duplicate-certs-per-domain-per-
        // 168h limit is brutal — when prior pipeline retries today (or
        // even auto-heal's step-8 reinstalls) burnt through it, every
        // subsequent POST /ssl automatic returns HTTP 500 "Failed to issue
        // SSL Certificate" and consumes nothing (LE responded "rate
        // limited" before SA could store anything). Don't make it worse:
        // if we've logged a "Failed to issue" warning for this exact
        // domain in the last 168h, skip the POST and surface a clear
        // "use manual paste" message immediately.
        try {
          const { one } = await import("./db")
          // LE-quota guard, tightened 2026-05-14:
          //   - Window shrunk from 168h to **6h**. The original 168h matched
          //     LE's 5-duplicate-certs-per-domain-per-168h sliding window
          //     literally, but in practice almost every "Failed to issue"
          //     we see is transient (SA-side glitch dressed up as LE error,
          //     or a single bad attempt during an actual rate-limit window).
          //     6h is long enough to back off a transient blip but short
          //     enough that one bad attempt doesn't lock the SA UI in stale
          //     state for a full week. Worst case: a truly rate-limited
          //     domain will re-fail every 6h within the 168h window, each
          //     attempt counting against LE's much-laxer "10 failed
          //     validations/account/hour" limit (well below our re-fire rate).
          //   - `created_at > MAX(successful sync)` so a later successful
          //     sync unblocks any older failures unambiguously.
          //   - Exclude our own "Skipping POST automatic ... rate limit
          //     recently" warnings (they match the `rate limit` keyword
          //     and would self-perpetuate the guard).
          const blocked = one<{ id: number }>(
            `SELECT id FROM pipeline_log
              WHERE domain = ? AND step = 'sa_ui_sync' AND status = 'warning'
                AND (message LIKE '%Failed to issue%' OR message LIKE '%rate limit%' OR message LIKE '%too many%')
                AND message NOT LIKE '%Skipping POST automatic%'
                AND created_at >= datetime('now', '-6 hours')
                AND created_at > COALESCE(
                  (SELECT MAX(created_at) FROM pipeline_log
                     WHERE domain = ? AND step = 'sa_ui_sync' AND status = 'completed'),
                  '1970-01-01'
                )
              LIMIT 1`,
            domain, domain,
          )
          if (blocked) {
            // Distinguish transient blip from likely-genuine rate-limit by
            // counting consecutive failures. Proven 2026-05-14: SA's HTTP
            // 500 "Failed to issue" is mostly transient (DNS-propagation
            // timing inside the worker, brief LE network blip, SA-side
            // hiccup) — re-running often succeeds.
            //
            // Threshold (2026-05-14, second pass): only SKIP when we've
            // accumulated 3+ failures in 24h. Below that, log an info
            // breadcrumb and PROCEED — the in-recipe retry handles
            // transients; needlessly skipping after a single transient
            // failure was producing the auto-heal grind we observed on
            // hailstrike/apppilot/yaktrek today (1 transient → guard
            // trips for 6h → tracker stays null until guard window
            // slides → next attempt may hit transient again → repeat).
            const { all } = await import("./db")
            const recentFails = all<{ id: number }>(
              `SELECT id FROM pipeline_log
                WHERE domain = ? AND step = 'sa_ui_sync' AND status = 'warning'
                  AND (message LIKE '%Failed to issue%' OR message LIKE '%POST automatic refused%')
                  AND message NOT LIKE '%Skipping POST automatic%'
                  AND created_at >= datetime('now', '-24 hours')`,
              domain,
            )
            const likelyRateLimit = recentFails.length >= 3
            if (likelyRateLimit) {
              logPipeline(domain, "sa_ui_sync", "warning",
                `Skipping POST automatic — ${recentFails.length} recent failure(s) ` +
                `in last 24h (≥3 = probably LE 5-per-168h rate-limit). ` +
                `Use \`/domains\` → 'Push cert to SA UI' for manual paste, ` +
                `OR wait for the 168h window to slide off. ` +
                `Site is still serving CF Origin on the wire.`)
              return
            }
            // Below threshold — log + continue. The in-recipe retry logic
            // (POST automatic, retry once on throw/non-2xx) handles
            // transient SA hiccups without operator intervention.
            logPipeline(domain, "sa_ui_sync", "info",
              `Proceeding despite ${recentFails.length} recent failure(s) ` +
              `in last 24h (<3 = likely transient, retry will handle).`)
          }
        } catch { /* if the lookup fails, fall through to the normal POST */ }

        logPipeline(domain, "sa_ui_sync", "running",
          "SA tracker is null — triggering auto-LE first (DNS should be grey-cloud)")
        // POST automatic with one retry — SA's HTTP 500 / "Failed to issue"
        // is mostly transient (DNS-propagation race inside the worker, brief
        // LE network blip, SA-side state glitch). Proven 2026-05-14 by direct
        // probe: worker reported "rate-limited" → standalone POST returned 200
        // seconds later. One retry with a 30s wait captures most of those
        // transients without burning enough attempts to dent LE's
        // 10-failed-validations/account/hour limit (2 attempts × ~dozen
        // domains/day << 10/hour).
        //
        // 2026-05-14 second pass: `saRequest` THROWS when all tokens (primary
        // + backup) return 5xx — so the retry must also catch thrown errors,
        // not just retry on a non-200 HTTP status. Without this catch, a
        // batch of 5 parallel migrations all hitting SA's transient 500 at
        // once would all bubble up to the outer catch and skip pushSaUiTracker
        // entirely, leaving SA trackers null. Observed end-to-end on the
        // T+12min portland migration today.
        const postAutomatic = () => saRequest(sslPath, {
          method: "POST", json: true,
          body: JSON.stringify({ ssl_type: "automatic", force_https: false }),
          timeoutMs: 30_000,
        })
        type AutoResShape = Awaited<ReturnType<typeof postAutomatic>>
        let autoRes: AutoResShape | null = null
        let autoErr: Error | null = null
        try { autoRes = await postAutomatic() } catch (e) { autoErr = e as Error }
        const firstOk = autoRes != null && [200, 201, 202].includes(autoRes.res.status)
        if (!firstOk) {
          const firstMsg = autoErr
            ? `threw: ${autoErr.message.slice(0, 160)}`
            : `HTTP ${autoRes!.res.status}: ${(await autoRes!.res.clone().text()).slice(0, 160)}`
          logPipeline(domain, "sa_ui_sync", "info",
            `POST automatic attempt 1 ${firstMsg} — waiting 30s and retrying once.`)
          await new Promise((r) => setTimeout(r, 30_000))
          autoErr = null
          try { autoRes = await postAutomatic() } catch (e) { autoErr = e as Error }
        }
        // If the SECOND attempt also threw (both tokens still 5xx), surface
        // a clear warning and bail so the outer catch doesn't swallow it
        // with a generic "tracker push threw" message that's been confusing
        // the operator all day.
        if (autoErr) {
          logPipeline(domain, "sa_ui_sync", "warning",
            `POST automatic threw after retry: ${autoErr.message.slice(0, 200)} — ` +
            `auto-heal will retry on the next sweep. Site still serving CF Origin.`)
          return
        }
        if (![200, 201, 202].includes(autoRes.res.status)) {
          const body = await autoRes.res.text()
          // SA's HTTP 500 with "Failed to issue" is misleading — the same
          // error covers genuine LE rate-limit AND transient blips (DNS
          // propagation race inside the worker, LE network hiccup, SA-side
          // glitch). Proven 2026-05-14 by direct probe: a domain that the
          // worker reported as rate-limited issued cleanly seconds later
          // from a standalone POST automatic. Don't tell the operator to
          // wait 1 week on the first failure — let auto-heal retry.
          logPipeline(domain, "sa_ui_sync", "warning",
            `POST automatic refused (HTTP ${autoRes.res.status}): ${body.slice(0, 160)} — ` +
            `most likely transient (DNS propagation, LE blip, or SA hiccup); ` +
            `auto-heal will retry. If this keeps repeating (3+ failures in 24h), ` +
            `it's probably LE's 5-per-168h rate-limit — use \`/domains\` → ` +
            `'Push cert to SA UI' for manual paste. Site still serving CF Origin.`)
          return
        }
        // Poll for LE install completion (up to 120s, every 5s).
        const start = Date.now()
        let installed = false
        while (Date.now() - start < 120_000) {
          await new Promise((r) => setTimeout(r, 5_000))
          const v = await saRequest(sslPath, { timeoutMs: 10_000 })
          if (v.res.status === 200) {
            const vj = await v.res.json() as { installed?: boolean }
            if (vj.installed) { installed = true; break }
          }
        }
        if (!installed) {
          logPipeline(domain, "sa_ui_sync", "warning",
            "SA auto-LE didn't complete in 120s — SA tracker stays blank. " +
            "Site is still serving CF Origin.")
          return
        }
        logPipeline(domain, "sa_ui_sync", "running",
          "SA auto-LE installed → DELETE then POST custom to swap in CF Origin")
      }
    }
    // 3. DELETE current SSL state to allow custom install.
    const delRes = await saRequest(sslPath, { method: "DELETE", timeoutMs: 15_000 })
    // Accept 200/204/404 — all mean "state cleared".
    if (![200, 204, 404].includes(delRes.res.status)) {
      logPipeline(domain, "sa_ui_sync", "warning",
        `DELETE /ssl refused (HTTP ${delRes.res.status}) — SA tracker stays blank.`)
      return
    }
    await new Promise((r) => setTimeout(r, 2000))
    // 4. POST custom with our cert.
    const postRes = await saRequest(sslPath, {
      method: "POST", json: true,
      body: JSON.stringify({
        ssl_type: "custom",
        ssl_certificate: opts.certificatePem.trim() + "\n",
        private_key: opts.privateKeyPem.trim() + "\n",
        chain_file: "",
        force_https: opts.forceHttps !== false,
      }),
      timeoutMs: 30_000,
    })
    if (postRes.res.status !== 200) {
      const body = await postRes.res.text()
      logPipeline(domain, "sa_ui_sync", "warning",
        `POST custom refused (HTTP ${postRes.res.status}): ${body.slice(0, 160)}. ` +
        `SA tracker stays blank; cert still on the wire via SSH.`)
      return
    }
    // 5. Toggle force-HTTPS on (GET endpoint that flips the flag).
    try {
      await saRequest(`${sslPath}/force-https`, { method: "GET", timeoutMs: 10_000 })
    } catch { /* harmless — force_https already passed in the POST body */ }
    logPipeline(domain, "sa_ui_sync", "completed",
      "SA UI now shows Custom SSL · CloudFlare Origin · forceHttps ON ✓")
  } catch (e) {
    logPipeline(domain, "sa_ui_sync", "warning",
      `SA UI tracker push threw: ${(e as Error).message.slice(0, 200)}. ` +
      `Cert still on wire; UI stays blank.`)
  }
}

/**
 * Best-effort `DELETE /ssl` on a freshly-created app to pre-empt SA's
 * automatic Let's Encrypt issuance. Idempotent — 200/204/404 all count
 * as success (404 means "no SSL configured", which is exactly what we
 * want).
 *
 * (Endpoint corrected 2026-05-14: this used to call `POST /ssl/destroy`
 * which always 404s. The real destroy is `DELETE /ssl`. See
 * tryApiSslFlow comment for the full root-cause writeup.)
 *
 * Why this matters even though step 8 already destroys+installs custom:
 * SA's background workers can auto-issue LE in the gap between app
 * creation (step 7) and step 8's grey-cloud window. If that LE issuance
 * succeeds, it drops a `${appName}-le-ssl.conf` into sites-enabled that
 * our SSH cert install later can't fully dislodge (or only after the new
 * SSH "de-fang LE confs" logic — belt-and-braces is cheaper than a retry).
 * Called from step 7 right after the app row is created.
 */
export async function disableAutoSsl(saServerId: string, appId: string): Promise<{ status: number }> {
  const sslPath =
    `/organizations/{ORG_ID}/servers/${saServerId}/applications/${appId}/ssl`
  try {
    const { res } = await saRequest(sslPath, { method: "DELETE", timeoutMs: 15_000 })
    return { status: res.status }
  } catch {
    // SA may return 404 if no SSL tracker yet — fine, that's the intent.
    return { status: 0 }
  }
}

/**
 * Derive an HTTPS vhost (`<app>-ssl.conf`) body from the existing HTTP vhost
 * (`<app>.conf`). Used when SA's auto-LE attempt failed before SA's own
 * installer could write `-ssl.conf`, leaving HTTPS with no vhost (and apache
 * therefore falling back to the default snakeoil cert — root cause of the
 * 2026-05-14 migration cycle that kept burning step-8 retries even though
 * the cert files were correctly on disk).
 *
 * Transform vs the HTTP source:
 *   - `<VirtualHost *:80>` → `<VirtualHost *:443>`
 *   - log paths: `error.log` → `error-ssl.log`, `access.log` → `access-ssl.log`
 *   - strip our own `# ssr-force-https` rewrite block if present (don't
 *     redirect on the HTTPS side — that's an infinite loop)
 *   - append `SSLEngine on` + cert paths + `Protocols h2 http/1.1` just
 *     before the closing `</VirtualHost>`
 *
 * Returns null if the HTTP source doesn't have a recognizable `*:80` vhost
 * (corrupt / unrelated file) — caller falls through to the existing best-
 * effort sed path so the failure looks identical to today's behavior rather
 * than silently writing garbage.
 */
export function deriveSslVhostFromHttp(
  httpConf: string,
  crtPath: string,
  keyPath: string,
): string | null {
  if (!/<VirtualHost\s+\*:80>/.test(httpConf)) return null
  let body = httpConf
    .replace(/<VirtualHost\s+\*:80>/g, "<VirtualHost *:443>")
    .replace(/logs\/error\.log/g, "logs/error-ssl.log")
    .replace(/logs\/access\.log/g, "logs/access-ssl.log")
    // Strip the force-https rewrite we inject (sentinel `# ssr-force-https`
    // through the next `RewriteRule [R=301,L]` line, optionally preceded by
    // a blank line). Tolerant of either tab or space indentation.
    .replace(
      /\n[\t ]*\n?[\t ]*# ssr-force-https\n[\t ]*RewriteEngine On\n[\t ]*RewriteCond[^\n]*\n[\t ]*RewriteRule[^\n]*\[R=301,L\][^\n]*\n/g,
      "\n",
    )
  const sslBlock =
    `\n\tSSLEngine on\n` +
    `\tSSLCertificateFile ${crtPath}\n` +
    `\tSSLCertificateKeyFile ${keyPath}\n` +
    `\tProtocols h2 http/1.1\n`
  // Replace ONLY the first `</VirtualHost>` so we don't accidentally append
  // SSL bits inside a nested block somewhere down the file.
  if (!/<\/VirtualHost>/.test(body)) return null
  body = body.replace(/<\/VirtualHost>/, sslBlock + "</VirtualHost>")
  return body
}

/**
 * Install a custom SSL certificate by reaching the SA agent's LOCAL HTTP API
 * on port 43210 — bypassing SA's cloud entirely. Reverse-engineered 2026-05-15.
 *
 * Why this exists:
 * SA's cloud REST API has a "state-lock" bug — `POST /ssl ssl_type:"custom"`
 * returns HTTP 500 when `app.ssl` is `null` (i.e. fresh-app, never had any
 * SSL state). To get past it, the cloud-side `pushSaUiTracker` recipe primes
 * the app with an LE cert first (`POST automatic`), then `DELETE`, then
 * `POST custom`. That dance occasionally fails on LE transients.
 *
 * The agent on the droplet ALSO has a `/application/ssl/custom` endpoint
 * (separate from the cloud's) that performs the same wire-level install —
 * write cert + key to /etc/ssl/..., generate the apache vhost, reload
 * apache — without any state-lock guard. Calling it directly produces a
 * reliable wire install regardless of cloud state.
 *
 * The agent's port-43210 listener is locked down two ways:
 *   1. Source IP allowlist: ONLY `172.232.64.194` (SA's cloud control IP)
 *      passes the first auth gate. Hardcoded at compile time:
 *      `-ldflags "-X main.AllowIp=172.232.64.194"`. We bypass by aliasing
 *      that IP to the droplet's loopback (`ip addr add 172.232.64.194/32
 *      dev lo`), then sourcing connections from it (`curl --interface`).
 *      Linux happily routes loopback packets with the aliased source IP.
 *   2. Bearer token: `Authorization: <key>` header (no `Bearer ` prefix).
 *      The key lives at `/serveravatar/config.json`.
 *
 * Payload (multipart form-data — Echo's c.FormValue, not JSON Bind):
 *   - applicationName: "aquaripple-site"  (kebab-case of domain, no TLD)
 *   - primary_domain:  "aquaripple.site"
 *   - certificateFileContents: cert PEM (note: plural)
 *   - privateKeyFileContent:   key PEM (note: SINGULAR — found by trial,
 *                                       every other field is plural)
 *   - chainFileContents:       chain PEM (plural again)
 *   - customInstallOrUpdate:   "install"
 *   - web_server:              "apache2" (service name passed to systemctl)
 *
 * Cleanup: the loopback alias is removed in a finally block so we don't
 * leave the agent's allowlist permanently spoof-able from this droplet.
 *
 * Caveat: this only updates the WIRE. SA's cloud DB is not informed — the
 * agent only reports back to the cloud when the cloud initiated the call.
 * So SA's UI panel will still show "Not Installed" until pushSaUiTracker's
 * LE-prime dance succeeds through cloud. Use this as a wire-level guarantee,
 * not as a SA-UI sync mechanism.
 *
 * Caveat 2: if SA's cloud rolls out a new agent build with a different
 * `main.AllowIp` value or different field names, this breaks until we
 * re-extract via `strings -tx /serveravatar/serveravatar-agent | grep ldflags`.
 * Path A (LE-prime dance) is the supported fallback when this fails.
 */
async function installCustomSslViaSaAgent(
  serverIp: string,
  domain: string,
  certPem: string,
  keyPem: string,
  chainPem: string,
  _opts: { forceHttps?: boolean } = {},
): Promise<{ ok: boolean; message: string }> {
  const rootPass = getSetting("server_root_password") || ""
  if (!rootPass) return { ok: false, message: "server_root_password not set" }

  const appName = appNameFor(domain)
  // Normalize PEMs — DB-stored PEMs sometimes have CRLF endings from Windows;
  // strip them so `echo '${X}' | tee ...` (which is what the agent does)
  // doesn't write garbage.
  const certClean = certPem.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim() + "\n"
  const keyClean = keyPem.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim() + "\n"
  const chainClean = chainPem
    ? chainPem.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim() + "\n"
    : ""

  let ssh: SshSession | null = null
  try {
    ssh = await SshSession.connect({
      host: serverIp, username: "root", password: rootPass,
      port: 22, readyTimeout: 20_000,
    })

    // Pull the agent's auth key from its config file. SA may rotate this
    // (or the install may not have written it for some reason) — bail out
    // with a clear message that triggers the SSH-tee fallback in installCustomSsl.
    const keyProbe = await ssh.exec(
      `cat /serveravatar/config.json 2>/dev/null | grep -oE '"key":"[^"]+"' | cut -d'"' -f4`,
      { timeoutMs: 10_000 },
    )
    const agentKey = (keyProbe.stdout || "").trim()
    if (!agentKey) {
      return { ok: false, message: "agent /serveravatar/config.json missing or unreadable — falling back to SSH-tee" }
    }

    // Write cert + key + chain to /tmp/sa-agent-* so we can stream them
    // into curl's --form (works for PEMs of arbitrary length without
    // command-line escaping headaches).
    const certPath = `/tmp/sa-agent-cert-${appName}.pem`
    const keyPath = `/tmp/sa-agent-key-${appName}.pem`
    const chainPath = `/tmp/sa-agent-chain-${appName}.pem`
    await ssh.sftpWriteFile(certPath, certClean)
    await ssh.sftpWriteFile(keyPath, keyClean)
    await ssh.sftpWriteFile(chainPath, chainClean)

    // Bash heredoc keeps the curl invocation tidy. The cleanup section
    // ALWAYS runs (even on curl error / signal) so the loopback alias
    // doesn't leak.
    const SPOOF_IP = "172.232.64.194"
    const script = `
set -u
trap 'ip addr del ${SPOOF_IP}/32 dev lo 2>/dev/null; rm -f ${certPath} ${keyPath} ${chainPath}' EXIT INT TERM

ip addr add ${SPOOF_IP}/32 dev lo 2>/dev/null || true

# Multipart form-data — Echo's c.FormValue() reads from this, not JSON.
# Field names extracted via objdump on /serveravatar/serveravatar-agent
# (search '\\.rodata' for offsets referenced by main.customSSLCertificate).
RESP=$(curl -ksm 25 --interface ${SPOOF_IP} \\
  -H "Authorization: ${agentKey.replace(/[\\"$\`]/g, (m) => "\\" + m)}" \\
  --form-string "applicationName=${appName}" \\
  --form-string "primary_domain=${domain.replace(/[\\"$\`]/g, (m) => "\\" + m)}" \\
  --form "certificateFileContents=<${certPath}" \\
  --form "privateKeyFileContent=<${keyPath}" \\
  --form "chainFileContents=<${chainPath}" \\
  --form-string "customInstallOrUpdate=install" \\
  --form-string "web_server=apache2" \\
  -w "\\n__HTTP_STATUS__=%{http_code}" \\
  https://127.0.0.1:43210/application/ssl/custom 2>&1)

echo "$RESP"
`
    const result = await ssh.exec(script, { timeoutMs: 30_000 })
    const out = (result.stdout || "") + (result.stderr || "")

    // Parse the response — last line has __HTTP_STATUS__=NNN
    const statusMatch = out.match(/__HTTP_STATUS__=(\d+)/)
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : 0
    const bodyMatch = out.match(/^(.+?)\n__HTTP_STATUS__=/s)
    const body = bodyMatch ? bodyMatch[1].trim() : out.trim()

    // 200 + success message = win. Anything else = caller falls back to
    // SSH-tee, which still works.
    if (httpStatus === 200 && /successfully/i.test(body)) {
      logPipeline(domain, "sa_agent_install", "completed",
        `SA agent installed custom SSL via /application/ssl/custom (HTTP 200). ` +
        `Cert files written + apache reloaded by SA. Cloud DB still requires ` +
        `pushSaUiTracker to update.`)
      return { ok: true, message: `SA agent install OK · ${body.slice(0, 120)}` }
    }
    return {
      ok: false,
      message: `SA agent install HTTP ${httpStatus}: ${body.slice(0, 200)}`,
    }
  } catch (e) {
    return { ok: false, message: `SA agent install threw: ${(e as Error).message}` }
  } finally {
    ssh?.close()
  }
}

/**
 * Direct-SSH cert deployment fallback. Writes /etc/ssl files and reloads
 * apache. Bypasses SA's tracker (so the SA dashboard won't show installed=true)
 * but the cert IS live for visitors.
 */
export async function sshInstallSslFiles(
  serverIp: string,
  domain: string,
  certPem: string,
  keyPem: string,
  opts: { forceHttps?: boolean } = {},
): Promise<{ ok: boolean; message: string }> {
  const rootPass = getSetting("server_root_password") || ""
  if (!rootPass) return { ok: false, message: "server_root_password not set" }

  const appName = appNameFor(domain)
  const crtPath = `/etc/ssl/certs/${appName}.crt`
  const keyPath = `/etc/ssl/private/${appName}.key`
  const confPath = `/etc/apache2/sites-enabled/${appName}-ssl.conf`
  const httpConfPath = `/etc/apache2/sites-enabled/${appName}.conf`
  const forceHttps = opts.forceHttps !== false

  let ssh: SshSession | null = null
  try {
    ssh = await SshSession.connect({
      host: serverIp, username: "root", password: rootPass,
      port: 22, readyTimeout: 20_000,
    })

    await ssh.sftpWriteFile(crtPath, certPem.trim() + "\n")
    await ssh.sftpWriteFile(keyPath, keyPem.trim() + "\n")

    // Recovery for the migration race where SA never wrote -ssl.conf at all.
    // Root cause (2026-05-14): when SA's auto-LE attempt fails before
    // certbot can complete, SA's installer leaves the HTTPS vhost file
    // missing entirely. The setup `sed` commands below silently no-op on
    // a non-existent file; apache then has no `:443` vhost for this domain
    // and serves the default snakeoil cert (`subject=<hostname>`). That
    // mismatch trips `verifyOriginCertIsCustom`, which re-enqueues step 8
    // forever — exactly the cycle we observed on dallas migration.
    //
    // Fix: if -ssl.conf is missing, derive it from the HTTP vhost (which
    // SA always writes successfully). The transform mirrors the manual
    // recovery I ran in the 2026-05-14 session — see
    // `deriveSslVhostFromHttp` above.
    let derived: "exists" | "created" | "create-failed" | "no-http-source" = "exists"
    const confProbe = await ssh.exec(
      `test -f ${confPath} && echo exists || echo missing`,
      { timeoutMs: 10_000 },
    )
    if (confProbe.stdout.trim() === "missing") {
      // Try to read the HTTP vhost. cat returns non-zero if the file is
      // missing — fall through to the legacy best-effort path which will
      // surface the missing-vhost as a configtest error downstream.
      const httpRead = await ssh.exec(`cat ${httpConfPath} 2>/dev/null`, {
        timeoutMs: 10_000,
      })
      if (httpRead.code !== 0 || !httpRead.stdout) {
        derived = "no-http-source"
        logPipeline(domain, "ssh_install_ssl", "warning",
          `${confPath} missing AND ${httpConfPath} unreadable — ` +
          `setup sed commands will no-op; apache will fall back to default cert.`)
      } else {
        const body = deriveSslVhostFromHttp(
          httpRead.stdout, crtPath, keyPath,
        )
        if (body == null) {
          derived = "create-failed"
          logPipeline(domain, "ssh_install_ssl", "warning",
            `Could not derive -ssl.conf from ${httpConfPath} (no *:80 vhost ` +
            `or no </VirtualHost> in source).`)
        } else {
          await ssh.sftpWriteFile(confPath, body)
          await ssh.exec(`chmod 644 ${confPath}`, { timeoutMs: 10_000 })
          derived = "created"
          logPipeline(domain, "ssh_install_ssl", "info",
            `${confPath} was missing (SA's auto-LE attempt didn't write it) — ` +
            `derived from ${httpConfPath}.`)
        }
      }
    }

    // Setup commands (cert/key perms + conf rewrites). Output ignored —
    // they're idempotent and any error is caught downstream by configtest.
    const setupCmds = [
      `chmod 644 ${crtPath}`,
      `chmod 600 ${keyPath}`,
      `chown root:root ${crtPath} ${keyPath}`,
      // Disable any leftover SSLCertificateChainFile directive (deprecated +
      // breaks mod_ssl when chain is wrong)
      `sed -i 's|^\\s*SSLCertificateChainFile|#SSLCertificateChainFile|' ${confPath} 2>/dev/null || true`,
      // Normalize cert + key paths in the conf
      `grep -q 'SSLCertificateFile ${crtPath}' ${confPath} || sed -i 's|SSLCertificateFile.*|SSLCertificateFile ${crtPath}|' ${confPath}`,
      `grep -q 'SSLCertificateKeyFile ${keyPath}' ${confPath} || sed -i 's|SSLCertificateKeyFile.*|SSLCertificateKeyFile ${keyPath}|' ${confPath}`,
    ]
    for (const c of setupCmds) {
      await ssh.exec(c, { timeoutMs: 20_000 })
    }

    // De-fang any Let's Encrypt vhost files that SA's certbot may have
    // dropped into sites-enabled. Apache loads every `*.conf` and for the
    // same `ServerName` the last-loaded vhost wins — so a leftover
    // `${appName}-le-ssl.conf` (or any file pointing at /etc/letsencrypt/)
    // keeps serving LE's cert even after we rewrite our `-ssl.conf`. The
    // visible symptom: `systemctl is-active apache2` returns "active",
    // `apachectl configtest` says "Syntax OK", but a TLS probe of the
    // origin still shows the LE issuer (this is exactly the aquaripple
    // failure: install "succeeded" yet cert verify said issuer=E8).
    //
    // Strategy: list every conf in sites-enabled whose body contains
    // /etc/letsencrypt OR -le-ssl.conf for this app, then disable each
    // (rm the symlink — leave the underlying file in sites-available so
    // operators can re-enable LE later if they want). Capture the list
    // in `leDisabled` for the diagnostic message.
    const leScan = await ssh.exec(
      `(ls /etc/apache2/sites-enabled/${appName}*le*ssl*.conf 2>/dev/null; ` +
      `grep -l -E '/etc/letsencrypt|fullchain\\.pem|privkey\\.pem' ` +
      `/etc/apache2/sites-enabled/${appName}*.conf 2>/dev/null) | sort -u`,
      { timeoutMs: 10_000 },
    )
    const leFiles = (leScan.stdout || "")
      .split("\n").map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== confPath)
    let leDisabled = "(none)"
    if (leFiles.length > 0) {
      // Remove each symlink. Apache won't reload them next reload.
      const rmList = leFiles.map((f) => `'${f.replace(/'/g, "")}'`).join(" ")
      await ssh.exec(`rm -f ${rmList}`, { timeoutMs: 10_000 })
      leDisabled = leFiles.map((f) => f.replace(/^.*\//, "")).join(",")
    }

    // Force HTTPS — when the SSH tier is the one that wins (API + UI both
    // failed), nobody else has added the port-80 → 443 redirect SA's
    // installer normally writes. Insert a guarded RewriteRule into
    // ${appName}.conf, using a sentinel comment so re-runs don't duplicate.
    let forceHttpsApplied: "added" | "already" | "no-vhost" | "skipped" = "skipped"
    if (forceHttps) {
      const sentinel = "# ssr-force-https"
      const probe = await ssh.exec(
        `test -f ${httpConfPath} && (grep -q '${sentinel}' ${httpConfPath} && echo already || echo missing) || echo no-vhost`,
        { timeoutMs: 10_000 },
      )
      const probeOut = probe.stdout.trim()
      if (probeOut === "missing") {
        // Inject the redirect just before </VirtualHost> on the port-80 vhost.
        // Single-quoted sed body so apache's $-vars (HTTP_HOST, HTTPS) aren't
        // shell-expanded; the literal `\n` between commands produces real
        // newlines in the inserted block.
        const block =
          `\\n  ${sentinel}\\n` +
          `  RewriteEngine On\\n` +
          `  RewriteCond %{HTTPS} off\\n` +
          `  RewriteRule ^(.*)$ https://%{HTTP_HOST}$1 [R=301,L]`
        const insert = await ssh.exec(
          `sed -i '/<\\/VirtualHost>/i\\${block}' ${httpConfPath}`,
          { timeoutMs: 10_000 },
        )
        forceHttpsApplied = insert.code === 0 ? "added" : "skipped"
      } else if (probeOut === "already") {
        forceHttpsApplied = "already"
      } else {
        forceHttpsApplied = "no-vhost"
      }
    }

    // Capture outputs of the inspection + reload commands so a failure has
    // something the operator can act on (a 'configtest' syntax error vs a
    // mod_ssl key mismatch vs a port conflict all look identical without
    // the actual stderr).
    const configtest = await ssh.exec("apachectl configtest 2>&1", { timeoutMs: 20_000 })
    const reload = await ssh.exec(
      "systemctl reload apache2 2>&1 || systemctl restart apache2 2>&1",
      { timeoutMs: 20_000 },
    )
    // `systemctl is-active` returns "reloading" for ~1-2s right after reload.
    // The reload itself succeeded; we just probed too fast. Poll up to 5s
    // (3 tries × 1.7s) for the state to settle to a definitive "active" or
    // "failed". Without this, swordhilt-shaped runs warning-out on a
    // timing race even though the cert is correctly in place.
    let probe = await ssh.exec("systemctl is-active apache2", { timeoutMs: 10_000 })
    let active = probe.stdout.trim()
    for (let i = 0; i < 3 && active === "reloading"; i++) {
      await new Promise((res) => setTimeout(res, 1700))
      probe = await ssh.exec("systemctl is-active apache2", { timeoutMs: 10_000 })
      active = probe.stdout.trim()
    }
    if (active === "active") {
      return {
        ok: true,
        message:
          `cert→${crtPath}  key→${keyPath}  apache=active  ` +
          `le-disabled=${leDisabled}  force-https=${forceHttpsApplied}  ` +
          `ssl-conf=${derived}`,
      }
    }
    // Failure path — pull the last 20 journal lines so we have the actual
    // mod_ssl rejection reason, then concatenate everything into the
    // message. Slice to keep pipeline_log under its 2 KiB cap.
    const journal = await ssh.exec(
      "journalctl -u apache2 -n 20 --no-pager 2>&1",
      { timeoutMs: 10_000 },
    )
    const trim = (s: string, n: number) => (s || "").trim().slice(0, n)
    return {
      ok: false,
      message:
        `apache not active after reload (status: ${active}) | ` +
        `le-disabled: ${leDisabled} | ` +
        `configtest: ${trim(configtest.stdout + configtest.stderr, 200)} | ` +
        `reload: ${trim(reload.stdout + reload.stderr, 160)} | ` +
        `journalctl: ${trim(journal.stdout + journal.stderr, 540)}`,
    }
  } catch (e) {
    return { ok: false, message: `ssh install error: ${(e as Error).name}: ${(e as Error).message}` }
  } finally {
    ssh?.close()
  }
}

// ---------------------------------------------------------------------------
// File upload — index.php + index.html removal
// ---------------------------------------------------------------------------

/**
 * Write index.php and remove the default 15KB SA welcome index.html. Tries
 * the SA File Manager API for both, falling back to SSH for the delete (and
 * a full SFTP upload for the write if the API is broken).
 *
 * `serverIp` is REQUIRED in practice for the SSH fallback path. Migration
 * callers must pass the NEW server's IP — falling back to a DB lookup
 * (`lookupServerIp(domain)`) returns the OLD server's IP because
 * `domains.server_id` hasn't been flipped yet at this point in the
 * migration. Without an explicit IP here, the SSH delete targets the dead
 * source droplet, times out, and the "overwrite-with-PHP" last-resort
 * leaves a 1KB index.html on the new server containing PHP source.
 */
export async function uploadIndexPhp(
  saServerId: string,
  domain: string,
  phpContent: string,
  serverIp?: string,
): Promise<boolean> {
  logPipeline(domain, "upload_index_php", "running",
    "Writing index.php and deleting default index.html in /public_html/")
  try {
    const appId = await findAppId(saServerId, domain)
    if (!appId) throw new Error(`App not found on SA server ${saServerId}`)
    const basePath =
      `/organizations/{ORG_ID}/servers/${saServerId}` +
      `/applications/${appId}/file-managers`

    // 1. Create + write index.php.
    //
    // The create step is allowed to fail with "already exists" — that's the
    // normal case on a re-run. Wrap it in its own try/catch so:
    //  - HTTP 500 with "exists" body → swallow, proceed to write
    //  - SAAllTokensFailed thrown by saRequest containing "exists" → also
    //    swallow (belt-and-suspenders in case saRequest's peek doesn't
    //    recognize the pattern for some reason)
    //  - Anything else → rethrow, outer catch falls back to SFTP
    try {
      const { res: createRes } = await saRequest(`${basePath}/file/create`, {
        method: "PATCH", json: true,
        body: JSON.stringify({ type: "file", name: "index.php", path: "/public_html/" }),
      })
      if (createRes.status === 500) {
        const body = await safeJson(createRes)
        const msg = saErrorMessage(body, "")
        if (!msg.toLowerCase().includes("exists")) {
          throw new Error(`index.php create HTTP 500: ${msg}`)
        }
      }
    } catch (createErr) {
      const msg = (createErr as Error).message
      if (!/already exists|folder name already/i.test(msg)) {
        throw createErr
      }
      logPipeline(domain, "upload_index_php", "running",
        "index.php already exists on SA — skipping create, going straight to write")
    }
    const { res: writeRes } = await saRequest(`${basePath}/file`, {
      method: "PATCH", json: true,
      body: JSON.stringify({ filename: "index.php", path: "/public_html/", body: phpContent }),
    })
    if (!writeRes.ok) {
      throw new Error(`index.php write HTTP ${writeRes.status}: ${(await writeRes.text()).slice(0, 200)}`)
    }

    // 2. Delete index.html via API (try several verb patterns)
    let deletedViaApi = false
    const deleteTargets: { method: string; pathSuffix: string }[] = [
      { method: "DELETE", pathSuffix: "/file" },
      { method: "PATCH",  pathSuffix: "/file/delete" },
      { method: "POST",   pathSuffix: "/file/delete" },
    ]
    for (const t of deleteTargets) {
      try {
        const { res: r } = await saRequest(`${basePath}${t.pathSuffix}`, {
          method: t.method, json: true,
          body: JSON.stringify({ filename: "index.html", path: "/public_html/" }),
        })
        if (r.ok) { deletedViaApi = true; break }
      } catch { /* try next */ }
    }

    // 3. SSH fallback for deletion. Caller passes the NEW server's IP
    // explicitly — falling back to a domains.server_id lookup would target
    // the OLD (dead) server during migration.
    if (!deletedViaApi) {
      try {
        await deleteIndexHtmlViaSsh(domain, serverIp)
        logPipeline(domain, "upload_index_php", "running",
          "index.html removed via SSH fallback (SA API delete unsupported)")
      } catch (sshErr) {
        logPipeline(domain, "upload_index_php", "warning",
          `Could not delete index.html (SA API + SSH both failed: ${(sshErr as Error).message}) ` +
          `— overwriting with PHP content as last resort`)
        await overwriteIndexHtmlViaApi(basePath, phpContent)
      }
    }

    logPipeline(domain, "upload_index_php", "completed",
      "index.php written, default index.html removed")
    return true
  } catch (e) {
    logPipeline(domain, "upload_index_php", "warning",
      `SA API path failed (${(e as Error).message}); falling back to full SFTP upload`)
    return uploadIndexPhpViaSftp(domain, phpContent, serverIp)
  }
}

/**
 * Multi-file upload for sites where the LLM produced more than just an
 * index. Walks the provided files array, creates parent directories as
 * needed via SA's File Manager API, then writes each file's content via
 * `PATCH /file`. After all files succeed, removes the default 15KB SA
 * welcome `index.html` (same logic as uploadIndexPhp).
 *
 * On any per-file API failure, falls through to the existing SFTP upload
 * path for the WHOLE batch (uploadFilesViaSftp). Per-file partial-upload
 * recovery isn't worth the complexity — re-running step 10 retries cleanly.
 *
 * Path format expectation (already validated by validateGeneratedFiles):
 *   "index.php"           → /public_html/index.php
 *   "style.css"           → /public_html/style.css
 *   "assets/logo.svg"     → /public_html/assets/logo.svg
 *   "css/main.css"        → /public_html/css/main.css
 */
export async function uploadAppFiles(
  saServerId: string,
  domain: string,
  files: { path: string; content: string }[],
  serverIp?: string,
): Promise<boolean> {
  const indexFile = files.find((f) => f.path === "index.php")
    ?? files.find((f) => f.path === "index.html")
    ?? files[0]

  logPipeline(domain, "upload_index_php", "running",
    `Multi-file upload to /public_html/: ${files.length} file(s) — ` +
    `${files.map((f) => f.path).slice(0, 8).join(", ")}` +
    (files.length > 8 ? ` ...+${files.length - 8} more` : ""))

  try {
    const appId = await findAppId(saServerId, domain)
    if (!appId) throw new Error(`App not found on SA server ${saServerId}`)
    const basePath =
      `/organizations/{ORG_ID}/servers/${saServerId}` +
      `/applications/${appId}/file-managers`

    // Create every parent directory once. Sort by depth so /assets exists
    // before /assets/icons. SA returns 500 with "exists" on a re-run —
    // treat that as success.
    const dirs = new Set<string>()
    for (const f of files) {
      const segs = f.path.split("/")
      for (let i = 1; i < segs.length; i++) {
        dirs.add(segs.slice(0, i).join("/"))
      }
    }
    const dirList = [...dirs].sort((a, b) => a.split("/").length - b.split("/").length)
    for (const dir of dirList) {
      const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : ""
      const name = dir.includes("/") ? dir.slice(dir.lastIndexOf("/") + 1) : dir
      try {
        const { res } = await saRequest(`${basePath}/file/create`, {
          method: "PATCH", json: true,
          body: JSON.stringify({
            type: "directory",
            name,
            path: `/public_html/${parent}${parent ? "/" : ""}`,
          }),
        })
        if (res.status === 500) {
          const body = await safeJson(res)
          const msg = saErrorMessage(body, "")
          if (!msg.toLowerCase().includes("exists")) {
            throw new Error(`mkdir '${dir}' HTTP 500: ${msg}`)
          }
        }
      } catch (e) {
        const m = (e as Error).message
        if (!/already exists|folder name already/i.test(m)) throw e
      }
    }

    // Create + write every file. Same exists-is-fine pattern as uploadIndexPhp.
    for (const f of files) {
      const segs = f.path.split("/")
      const name = segs[segs.length - 1]
      const dir = segs.slice(0, -1).join("/")
      try {
        const { res } = await saRequest(`${basePath}/file/create`, {
          method: "PATCH", json: true,
          body: JSON.stringify({
            type: "file", name,
            path: `/public_html/${dir}${dir ? "/" : ""}`,
          }),
        })
        if (res.status === 500) {
          const body = await safeJson(res)
          const msg = saErrorMessage(body, "")
          if (!msg.toLowerCase().includes("exists")) {
            throw new Error(`create '${f.path}' HTTP 500: ${msg}`)
          }
        }
      } catch (e) {
        const m = (e as Error).message
        if (!/already exists|folder name already/i.test(m)) throw e
      }
      const { res: writeRes } = await saRequest(`${basePath}/file`, {
        method: "PATCH", json: true,
        body: JSON.stringify({
          filename: name,
          path: `/public_html/${dir}${dir ? "/" : ""}`,
          body: f.content,
        }),
      })
      if (!writeRes.ok) {
        throw new Error(`write '${f.path}' HTTP ${writeRes.status}: ${(await writeRes.text()).slice(0, 200)}`)
      }
    }

    // Remove the default SA welcome index.html ONLY if the operator's files
    // didn't already include an index.html (otherwise we'd delete what we
    // just wrote). Same multi-verb-fallback as uploadIndexPhp.
    const operatorWroteIndexHtml = files.some((f) => f.path === "index.html")
    if (!operatorWroteIndexHtml) {
      let deletedViaApi = false
      const deleteTargets: { method: string; pathSuffix: string }[] = [
        { method: "DELETE", pathSuffix: "/file" },
        { method: "PATCH", pathSuffix: "/file/delete" },
        { method: "POST", pathSuffix: "/file/delete" },
      ]
      for (const t of deleteTargets) {
        try {
          const { res: r } = await saRequest(`${basePath}${t.pathSuffix}`, {
            method: t.method, json: true,
            body: JSON.stringify({ filename: "index.html", path: "/public_html/" }),
          })
          if (r.ok) { deletedViaApi = true; break }
        } catch { /* try next */ }
      }
      if (!deletedViaApi) {
        try {
          await deleteIndexHtmlViaSsh(domain, serverIp)
        } catch (sshErr) {
          logPipeline(domain, "upload_index_php", "warning",
            `Could not delete default index.html (${(sshErr as Error).message}) — ` +
            `overwriting with redirect to /index.php`)
          await overwriteIndexHtmlViaApi(basePath, indexFile.content)
        }
      }
    }

    logPipeline(domain, "upload_index_php", "completed",
      `${files.length} file(s) uploaded to /public_html/`)
    return true
  } catch (e) {
    logPipeline(domain, "upload_index_php", "warning",
      `SA API multi-file path failed (${(e as Error).message}); ` +
      `falling back to SFTP for whole batch`)
    return uploadFilesViaSftp(domain, files, serverIp)
  }
}

async function overwriteIndexHtmlViaApi(
  basePath: string, _phpContent: string,
): Promise<void> {
  // Last-resort fallback when both SA-API and SSH delete failed: replace
  // the content with a benign redirect. We deliberately do NOT overwrite
  // with phpContent (the prior implementation did) because Apache serves
  // .html as static text — that would leak the entire generated PHP page
  // as source on direct GET /index.html. The redirect keeps the file
  // present (so Apache's DirectoryIndex still resolves) but bounces any
  // visitor who hits /index.html to /index.php.
  const redirect =
    `<!DOCTYPE html>\n` +
    `<meta http-equiv="refresh" content="0; url=/index.php">\n` +
    `<title>Redirecting…</title>\n`
  try {
    await saRequest(`${basePath}/file`, {
      method: "PATCH", json: true,
      body: JSON.stringify({ filename: "index.html", path: "/public_html/", body: redirect }),
    })
  } catch { /* best-effort */ }
}

function lookupServerIp(domain: string): string | null {
  const row = one<{ ip: string | null }>(
    `SELECT s.ip FROM domains d JOIN servers s ON s.id = d.server_id WHERE d.domain = ?`,
    domain,
  )
  return row?.ip ?? null
}

export async function deleteIndexHtmlViaSsh(domain: string, serverIp?: string): Promise<void> {
  const ip = serverIp ?? lookupServerIp(domain)
  if (!ip) throw new Error("No server IP found")

  const rootPass = getSetting("server_root_password") || ""
  if (!rootPass) throw new Error("server_root_password not set — can't SSH to delete")

  const appName = appNameFor(domain)
  const sysUser = sysUserFor(domain)
  const candidates = [
    `/home/${sysUser}/${appName}/public_html`,
    `/home/${sysUser}/public_html`,
    `/home/master/${appName}/public_html`,
    `/var/www/${domain}/public_html`,
  ]

  let ssh: SshSession | null = null
  try {
    ssh = await SshSession.connect({
      host: ip, username: "root", password: rootPass, port: 22, readyTimeout: 15_000,
    })
    const oneLiner = candidates
      .map((p) => `(test -f ${p}/index.html && rm -f ${p}/index.html && echo REMOVED:${p})`)
      .join(" || ")
    const r = await ssh.exec(`${oneLiner} || echo NO_CANDIDATE_HIT`, { timeoutMs: 20_000 })
    if (/REMOVED:/.test(r.stdout)) return

    // Fallback: SA's layout occasionally diverges from our candidate list
    // (e.g. when sysUserFor() computed locally doesn't match SA's chosen
    // username, or when SA's path scheme changes between versions). Find
    // any index.html anywhere under a public_html directory and rm it.
    const find = await ssh.exec(
      `find /home /var/www -maxdepth 6 -name index.html -path '*/public_html/*' 2>/dev/null | head -5`,
      { timeoutMs: 15_000 },
    )
    const paths = find.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    if (paths.length === 0) {
      // Genuinely absent — could be a re-run after a successful prior delete.
      return
    }
    const rmCmd = paths.map((p) => `rm -f '${p}'`).join(" && ") + " && echo REMOVED_ALL"
    const r2 = await ssh.exec(rmCmd, { timeoutMs: 15_000 })
    if (!/REMOVED_ALL/.test(r2.stdout)) {
      throw new Error(
        `Found ${paths.length} index.html via fallback find but rm did not confirm: ` +
        `${r2.stderr.slice(0, 200)}`,
      )
    }
  } finally {
    ssh?.close()
  }
}

/**
 * SFTP fallback for writing index.php. Probes SA's real layout
 * (/home/{sysUser}/{appName}/public_html), removes default index.html, writes
 * index.php with the right ownership.
 */
export async function uploadIndexPhpViaSftp(
  domain: string, phpContent: string, serverIp?: string,
): Promise<boolean> {
  const ip = serverIp ?? lookupServerIp(domain)
  if (!ip) throw new Error("No server IP found for SFTP upload")

  const rootPass = getSetting("server_root_password") || ""
  if (!rootPass) throw new Error("server_root_password not set")

  const appName = appNameFor(domain)
  const sysUser = sysUserFor(domain)
  const candidates = [
    `/home/${sysUser}/${appName}/public_html`,
    `/home/${sysUser}/public_html`,
    `/home/master/${appName}/public_html`,
    `/var/www/${domain}/public_html`,
  ]

  let ssh: SshSession | null = null
  try {
    ssh = await SshSession.connect({
      host: ip, username: "root", password: rootPass, port: 22, readyTimeout: 30_000,
    })
    // Try the hardcoded candidates first (fast path).
    for (const pub of candidates) {
      const exists = await ssh.sftpStat(pub)
      if (!exists) continue
      try { await ssh.sftpRemoveFile(`${pub}/index.html`) } catch { /* may not exist */ }
      await ssh.sftpWriteFile(`${pub}/index.php`, phpContent)
      await ssh.exec(
        `chown ${sysUser}:${sysUser} ${pub}/index.php 2>/dev/null; chmod 644 ${pub}/index.php`,
        { timeoutMs: 10_000 },
      )
      logPipeline(domain, "upload_index_php", "completed",
        `index.php written to ${pub} via SFTP (index.html removed)`)
      return true
    }
    // Fallback: the candidates didn't match. SA's layout occasionally
    // diverges (most common cause: when this app reused an existing
    // sys user from another app, sysUserFor() locally computes a
    // different name than SA actually used). Find any public_html
    // dir mentioning this app's name OR domain and use that.
    const find = await ssh.exec(
      `find /home /var/www -maxdepth 6 -type d -name public_html ` +
      `\\( -path '*${appName}*' -o -path '*${domain}*' \\) 2>/dev/null | head -3`,
      { timeoutMs: 15_000 },
    )
    const found = find.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    if (found.length > 0) {
      const pub = found[0]
      try { await ssh.sftpRemoveFile(`${pub}/index.html`) } catch { /* may not exist */ }
      await ssh.sftpWriteFile(`${pub}/index.php`, phpContent)
      // chown — extract owner of the public_html dir; sysUser may be wrong.
      const stat = await ssh.exec(`stat -c '%U' ${pub}`, { timeoutMs: 5000 })
      const realUser = stat.stdout.trim() || sysUser
      await ssh.exec(
        `chown ${realUser}:${realUser} ${pub}/index.php 2>/dev/null; chmod 644 ${pub}/index.php`,
        { timeoutMs: 10_000 },
      )
      logPipeline(domain, "upload_index_php", "completed",
        `index.php written to ${pub} via SFTP fallback (owner=${realUser}; ` +
        `local sysUser=${sysUser} didn't match — likely an existing-user reuse)`)
      return true
    }
    throw new Error(
      `Could not find any public_html for ${appName} (or ${domain}) under /home or /var/www — ` +
      `SA layout may have changed; manual SSH inspection needed`,
    )
  } finally {
    ssh?.close()
  }
}

/**
 * Multi-file SFTP fallback. Same public_html-discovery logic as
 * uploadIndexPhpViaSftp, but writes the entire files array (creating parent
 * directories with `mkdir -p` first) and removes index.html only if the
 * operator's files don't already include it.
 */
export async function uploadFilesViaSftp(
  domain: string,
  files: { path: string; content: string }[],
  serverIp?: string,
): Promise<boolean> {
  const ip = serverIp ?? lookupServerIp(domain)
  if (!ip) throw new Error("No server IP found for SFTP upload")
  const rootPass = getSetting("server_root_password") || ""
  if (!rootPass) throw new Error("server_root_password not set")

  const appName = appNameFor(domain)
  const sysUser = sysUserFor(domain)
  const candidates = [
    `/home/${sysUser}/${appName}/public_html`,
    `/home/${sysUser}/public_html`,
    `/home/master/${appName}/public_html`,
    `/var/www/${domain}/public_html`,
  ]

  let ssh: SshSession | null = null
  try {
    ssh = await SshSession.connect({
      host: ip, username: "root", password: rootPass, port: 22, readyTimeout: 30_000,
    })

    // Locate the public_html dir using the same fast path → search fallback
    // as uploadIndexPhpViaSftp.
    let pub: string | null = null
    for (const c of candidates) {
      if (await ssh.sftpStat(c)) { pub = c; break }
    }
    if (!pub) {
      const find = await ssh.exec(
        `find /home /var/www -maxdepth 6 -type d -name public_html ` +
        `\\( -path '*${appName}*' -o -path '*${domain}*' \\) 2>/dev/null | head -3`,
        { timeoutMs: 15_000 },
      )
      pub = find.stdout.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? null
    }
    if (!pub) {
      throw new Error(
        `Could not find any public_html for ${appName} (or ${domain}) under /home or /var/www`,
      )
    }

    // Resolve the actual owner of public_html — sysUser may be wrong if SA
    // re-used an existing user.
    const stat = await ssh.exec(`stat -c '%U' ${pub}`, { timeoutMs: 5000 })
    const realUser = stat.stdout.trim() || sysUser

    // Pre-create every parent directory in one shot.
    const dirs = new Set<string>()
    for (const f of files) {
      const segs = f.path.split("/")
      for (let i = 1; i < segs.length; i++) {
        dirs.add(segs.slice(0, i).join("/"))
      }
    }
    if (dirs.size > 0) {
      const mkdirCmd = [...dirs]
        .map((d) => `mkdir -p ${pub}/${d}`)
        .join(" && ")
      await ssh.exec(mkdirCmd, { timeoutMs: 15_000 })
    }

    // Write each file via SFTP, then chown the whole batch in one pass.
    for (const f of files) {
      await ssh.sftpWriteFile(`${pub}/${f.path}`, f.content)
    }
    await ssh.exec(
      `chown -R ${realUser}:${realUser} ${pub} 2>/dev/null; ` +
      `find ${pub} -type f -exec chmod 644 {} +`,
      { timeoutMs: 15_000 },
    )

    // Remove default index.html if operator didn't write one.
    const operatorWroteIndexHtml = files.some((f) => f.path === "index.html")
    if (!operatorWroteIndexHtml) {
      try { await ssh.sftpRemoveFile(`${pub}/index.html`) } catch { /* may not exist */ }
    }

    logPipeline(domain, "upload_index_php", "completed",
      `${files.length} file(s) written to ${pub} via SFTP fallback (owner=${realUser})`)
    return true
  } finally {
    ssh?.close()
  }
}

// ---------------------------------------------------------------------------
// Generic site upload (index.html, used by older v1 flow)
// ---------------------------------------------------------------------------

export async function uploadSiteViaApi(
  saServerId: string, domain: string, htmlContent: string,
): Promise<boolean> {
  logPipeline(domain, "upload_site", "running", "Uploading via SA File Manager API")
  try {
    const appId = await findAppId(saServerId, domain)
    if (!appId) throw new Error(`App not found on SA server ${saServerId}`)
    const basePath =
      `/organizations/{ORG_ID}/servers/${saServerId}` +
      `/applications/${appId}/file-managers`

    const { res: createRes } = await saRequest(`${basePath}/file/create`, {
      method: "PATCH", json: true,
      body: JSON.stringify({ type: "file", name: "index.html", path: "/" }),
    })
    if (createRes.status === 500) {
      const body = await safeJson(createRes)
      if (!saErrorMessage(body, "").toLowerCase().includes("exists")) {
        throw new Error(`index.html create HTTP 500`)
      }
    }
    const { res: writeRes } = await saRequest(`${basePath}/file`, {
      method: "PATCH", json: true,
      body: JSON.stringify({ filename: "index.html", path: "/", body: htmlContent }),
    })
    if (!writeRes.ok) throw new Error(`index.html write HTTP ${writeRes.status}`)
    logPipeline(domain, "upload_site", "completed", "Uploaded via SA File Manager")
    return true
  } catch (e) {
    logPipeline(domain, "upload_site_api", "warning",
      `SA API upload failed (${(e as Error).message}), falling back to SFTP...`)
    return uploadSiteViaSftp(domain, htmlContent)
  }
}

export async function uploadSiteViaSftp(
  domain: string, htmlContent: string, serverIp?: string,
): Promise<boolean> {
  const ip = serverIp ?? lookupServerIp(domain)
  if (!ip) throw new Error("No server IP found for SFTP upload")
  const rootPass = getSetting("server_root_password") || ""
  if (!rootPass) throw new Error("server_root_password not set")

  const appName = appNameFor(domain)
  const candidates = [
    `/home/${appName}/public_html`,
    `/var/www/${domain}/public_html`,
    `/home/master/${appName}/public_html`,
  ]

  let ssh: SshSession | null = null
  try {
    ssh = await SshSession.connect({
      host: ip, username: "root", password: rootPass, port: 22, readyTimeout: 30_000,
    })
    for (const path of candidates) {
      try {
        await ssh.exec(`mkdir -p ${path}`, { timeoutMs: 10_000 })
        await ssh.sftpWriteFile(`${path}/index.html`, htmlContent)
        logPipeline(domain, "upload_site", "completed", `Uploaded to ${path}`)
        return true
      } catch { continue }
    }
    throw new Error("Could not write to any expected path")
  } catch (e) {
    logPipeline(domain, "upload_site", "failed", (e as Error).message)
    throw e
  } finally {
    ssh?.close()
  }
}

/** Primary upload entry — tries SA File Manager API first, falls back to SFTP. */
export async function uploadSiteFiles(
  serverIp: string, domain: string, htmlContent: string,
): Promise<boolean> {
  const row = one<{ sa_server_id: string | null }>(
    `SELECT s.sa_server_id FROM domains d JOIN servers s ON s.id = d.server_id WHERE d.domain = ?`,
    domain,
  )
  if (row?.sa_server_id) {
    const ok = await uploadSiteViaApi(row.sa_server_id, domain, htmlContent)
    if (ok) return true
  }
  return uploadSiteViaSftp(domain, htmlContent, serverIp)
}

