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
 * servers that were manually deleted from the SA dashboard. */
export async function isSaServerAlive(saServerId: string): Promise<boolean> {
  try {
    const { res } = await saRequest(`/organizations/{ORG_ID}/servers/${saServerId}`, {
      timeoutMs: 10_000,
    })
    return res.status === 200
  } catch {
    return false
  }
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
 * Install a Cloudflare Origin CA cert on an SA app.
 *
 * Three-step API sequence (per SA's blog) primes the SA tracker so the
 * dashboard correctly reflects the installed state:
 *   1. POST /ssl  ssl_type=automatic   → creates SA's tracker entry
 *   2. POST /ssl/destroy               → clears the auto cert
 *   3. POST /ssl  ssl_type=custom      → installs our cert
 *
 * If any step fails, fall back to direct SSH cert deployment + apache reload.
 * The Flask side has an additional UI-automation middle path; that is NOT
 * ported here — only API → SSH.
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
  const ssh = await sshInstallSslFiles(
    opts.serverIp, opts.domain, opts.certificatePem, opts.privateKeyPem,
  )
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

async function tryApiSslFlow(
  sslPath: string,
  opts: InstallSslOpts,
): Promise<{ ok: boolean; message: string }> {
  try {
    // 1. Install automatic (Let's Encrypt) — primes the tracker
    let { res: r } = await saRequest(sslPath, {
      method: "POST", json: true,
      body: JSON.stringify({ ssl_type: "automatic", force_https: false }),
    })
    if (!r.ok) {
      return { ok: false, message: `auto-install refused (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}` }
    }
    await new Promise((res) => setTimeout(res, 3000))

    // 2. Destroy — clears Let's Encrypt cert
    ;({ res: r } = await saRequest(`${sslPath}/destroy`, { method: "POST" }))
    if (![200, 204, 404].includes(r.status)) {
      return { ok: false, message: `destroy failed (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}` }
    }
    await new Promise((res) => setTimeout(res, 2000))

    // 3. Install custom — our CF Origin CA cert
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
      return { ok: false, message: `custom-install refused (HTTP ${r.status}): ${saErrorMessage(body, "")}` }
    }

    // 4. Verify tracker
    let trackerOk: boolean | null = null
    try {
      const { res: gr } = await saRequest(sslPath, { timeoutMs: 15_000 })
      if (gr.ok) {
        const body = (await gr.json()) as { installed?: boolean }
        trackerOk = Boolean(body.installed)
      }
    } catch { /* ignore */ }

    return { ok: true, message: `SA API sequence complete; tracker installed=${trackerOk}` }
  } catch (e) {
    return { ok: false, message: `API flow exception: ${(e as Error).message}` }
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
): Promise<{ ok: boolean; message: string }> {
  const rootPass = getSetting("server_root_password") || ""
  if (!rootPass) return { ok: false, message: "server_root_password not set" }

  const appName = appNameFor(domain)
  const crtPath = `/etc/ssl/certs/${appName}.crt`
  const keyPath = `/etc/ssl/private/${appName}.key`
  const confPath = `/etc/apache2/sites-enabled/${appName}-ssl.conf`

  let ssh: SshSession | null = null
  try {
    ssh = await SshSession.connect({
      host: serverIp, username: "root", password: rootPass,
      port: 22, readyTimeout: 20_000,
    })

    await ssh.sftpWriteFile(crtPath, certPem.trim() + "\n")
    await ssh.sftpWriteFile(keyPath, keyPem.trim() + "\n")

    const cmds = [
      `chmod 644 ${crtPath}`,
      `chmod 600 ${keyPath}`,
      `chown root:root ${crtPath} ${keyPath}`,
      // Disable any leftover SSLCertificateChainFile directive (deprecated +
      // breaks mod_ssl when chain is wrong)
      `sed -i 's|^\\s*SSLCertificateChainFile|#SSLCertificateChainFile|' ${confPath} 2>/dev/null || true`,
      // Normalize cert + key paths in the conf
      `grep -q 'SSLCertificateFile ${crtPath}' ${confPath} || sed -i 's|SSLCertificateFile.*|SSLCertificateFile ${crtPath}|' ${confPath}`,
      `grep -q 'SSLCertificateKeyFile ${keyPath}' ${confPath} || sed -i 's|SSLCertificateKeyFile.*|SSLCertificateKeyFile ${keyPath}|' ${confPath}`,
      `apachectl configtest 2>&1`,
      `systemctl reload apache2 2>&1 || systemctl restart apache2 2>&1`,
    ]
    for (const c of cmds) {
      await ssh.exec(c, { timeoutMs: 20_000 })
    }
    const probe = await ssh.exec("systemctl is-active apache2", { timeoutMs: 10_000 })
    const active = probe.stdout.trim()
    if (active === "active") {
      return { ok: true, message: `cert→${crtPath}  key→${keyPath}  apache=active` }
    }
    return { ok: false, message: `apache not active after reload (status: ${active})` }
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

