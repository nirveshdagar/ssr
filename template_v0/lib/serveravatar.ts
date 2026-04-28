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
      const body = (await res.text()).slice(0, 200).replace(/\n/g, " ")
      attempts.push([c.label, `HTTP ${res.status} — ${body}`])
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
  const region = opts.region ?? "nyc1"
  const size = opts.size ?? "s-2vcpu-4gb"
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
export async function installAgentOnDroplet(opts: {
  dropletIp: string
  serverName: string
  timeoutInstallMs?: number
  /** Called with a human-readable status line each time we have new info
   *  (post-SSH-launch, every poll iteration). The orchestrator wires this
   *  to updateStep so the watcher shows live progress instead of a frozen
   *  message during the 5-15 min agent install. */
  onProgress?: (message: string) => void
}): Promise<string> {
  const { dropletIp, serverName } = opts
  const timeoutInstallMs = opts.timeoutInstallMs ?? 900_000
  const onProgress = opts.onProgress ?? (() => { /* no-op */ })

  const rootPassword = getSetting("server_root_password") || ""
  if (!rootPassword) throw new Error("server_root_password not set")

  logPipeline(serverName, "sa_install", "running",
    `Requesting SA install command for ${serverName}`)
  const cmd = await generateInstallCommand({ serverName })

  logPipeline(serverName, "sa_install", "running", `Waiting for SSH on ${dropletIp}...`)
  const ssh = await waitForSsh(dropletIp, rootPassword, "root", 240_000)
  try {
    logPipeline(serverName, "sa_install", "running",
      `Running install script on ${dropletIp} (takes 5-15 min)`)
    // Full detach so the SSH channel closes immediately:
    //   - subshell `( … & )` so the child loses its parent shell
    //   - redirect stdin from /dev/null (otherwise ssh2 keeps the channel
    //     open waiting for EOF on the inherited fd)
    //   - redirect stdout/stderr to install.log
    //   - setsid when available so the child gets its own session/pgid
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
      // If the launcher exec didn't return cleanly we still want to poll
      // SA — the install may have started on the droplet regardless. The
      // poll loop below is the authoritative success signal anyway.
      logPipeline(serverName, "sa_install", "warning",
        `SSH launcher did not return cleanly (${(e as Error).message.slice(0, 200)}); ` +
        `polling SA for agent appearance anyway`)
    }

    // Poll SA-side for the server to appear as connected
    const start = Date.now()
    const deadline = start + timeoutInstallMs
    const totalMin = Math.round(timeoutInstallMs / 60_000)
    let saServerId: string | null = null
    let lastSaStatus = "(none)"
    onProgress(
      `Installing SA agent on ${dropletIp} — 0m elapsed / ${totalMin}m max · ` +
      `polling SA every 30s`,
    )
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
            `SA agent active; sa_server_id=${saServerId}`)
          return saServerId
        }
      }
      if (saServerId) {
        // Confirm via dedicated GET
        try {
          const info = await getServerInfo(saServerId)
          const status = String(info.agent_status ?? info.status ?? "")
          lastSaStatus = status || lastSaStatus
          if (status === "connected" || status === "active" || status === "1") {
            logPipeline(serverName, "sa_install", "completed",
              `SA agent active; sa_server_id=${saServerId}`)
            return saServerId
          }
        } catch { /* keep polling */ }
      }
      const elapsedMin = Math.round((Date.now() - start) / 60_000)
      onProgress(
        `Installing SA agent on ${dropletIp} — ${elapsedMin}m / ${totalMin}m · ` +
        `SA status: ${lastSaStatus}` +
        (saServerId ? ` (sa_id=${saServerId})` : " (not yet visible to SA)"),
      )
    }

    // Timeout — read install.log tail for diagnosis
    let tail = "(could not read install.log)"
    try {
      const r = await ssh.exec("tail -n 50 /root/sa_install/install.log", { timeoutMs: 15_000 })
      tail = r.stdout
    } catch { /* ignore */ }
    throw new Error(
      `SA agent did not become active within ${timeoutInstallMs}ms. ` +
      `Install log tail:\n${tail.slice(-1500)}`,
    )
  } finally {
    ssh.close()
  }
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
          message: `UI install OK (${ui.message}). API failed: ${apiResult.message}`,
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
      message: `SSH fallback OK (${ssh.message}). API failed: ${apiResult.message}  UI failed: ${uiMsg}`,
    }
  }
  throw new Error(
    `All three SSL install paths failed. API: ${apiResult.message}  ` +
    `UI: ${uiMsg}  SSH: ${ssh.message}`,
  )
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

    // 1. Create + write index.php
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
    throw new Error(
      `Could not find a valid public_html under /home/${sysUser}/… — SA layout may have changed`,
    )
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

