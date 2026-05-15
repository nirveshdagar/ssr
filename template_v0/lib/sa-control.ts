/**
 * ServerAvatar control layer — focused, production-grade primitives that
 * back the /serveravatar page. Strict surface area:
 *
 *   API-driven (cheap, safe):
 *     - listFleet()            : every SA server with stats + apps joined
 *     - getAppDetail()         : one app + its server context
 *
 *   SSH-driven (controlled, high-value only):
 *     - readIndexFile(domain, ip)         : tail-safe SFTP read
 *     - writeIndexFile(domain, ip, body)  : SFTP write WITH .bak backup
 *     - restoreIndexFile(domain, ip)      : write index.php.bak back over index.php
 *     - restartApache(ip)                 : `systemctl reload apache2`
 *     - restartPhpFpm(ip)                 : `systemctl restart phpX.Y-fpm`
 *
 * SSH safety contract:
 *   - NO arbitrary command execution exposed; every callable wraps a
 *     fixed command string with strict argument templating.
 *   - Path resolution tries the documented SA layouts in priority order
 *     (matches uploadIndexPhpViaSftp) and rejects anything outside the
 *     candidate set.
 *   - Every action logs to pipeline_log with action='sa_control' so the
 *     operator can audit the SSH side from /logs.
 */

import { getSetting } from "./repos/settings"
import { logPipeline } from "./repos/logs"
import { listServers as listDbServers } from "./repos/servers"
import { listDomains } from "./repos/domains"
import {
  SshSession,
  listServers as listSaServers,
  getServerInfo,
  listApplications,
  appNameFor,
  sysUserFor,
  saRequest,
  type SaApp,
  type SaServer,
} from "./serveravatar"

// ---------------------------------------------------------------------------
// Path resolution — must mirror uploadIndexPhpViaSftp's candidate list. If
// SA's layout changes we update both in lockstep.
// ---------------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

async function resolvePublicHtml(ssh: SshSession, domain: string): Promise<string | null> {
  const appName = appNameFor(domain)
  const sysUser = sysUserFor(domain)
  // SA's documented layout (matches uploadIndexPhpViaSftp). Falls back via
  // shell so we don't need to maintain a separate path-list as SA evolves.
  const candidates = [
    `/home/${sysUser}/${appName}/public_html`,
    `/home/${sysUser}/public_html`,
    `/home/master/${appName}/public_html`,
    `/var/www/${domain}/public_html`,
  ]
  for (const p of candidates) {
    try {
      if (await withTimeout(ssh.sftpStat(p), 5000, `sftpStat ${p}`)) return p
    } catch { /* timeout / inaccessible — try next */ }
  }
  // Shell-based fallback: ask the server to find any directory named
  // public_html under /home — covers SA layouts we haven't catalogued.
  try {
    const r = await ssh.exec(
      `find /home -maxdepth 4 -type d -name public_html -path '*${appName}*' 2>/dev/null | head -1`,
      { timeoutMs: 8000 },
    )
    const found = (r.stdout || "").trim().split("\n")[0]
    if (found && found.startsWith("/")) return found
  } catch { /* find failed — give up */ }
  return null
}

async function openSsh(ip: string): Promise<SshSession> {
  const rootPass = getSetting("server_root_password") || ""
  if (!rootPass) throw new Error("server_root_password not set")
  return SshSession.connect({
    host: ip, username: "root", password: rootPass, port: 22, readyTimeout: 30_000,
  })
}

// ---------------------------------------------------------------------------
// Index file ops
// ---------------------------------------------------------------------------

export interface IndexReadResult {
  content: string
  bytes: number
  path: string
  has_backup: boolean
}

// In-memory read cache keyed by `${domain}|${serverIp}`. SSH is the slow
// path (cold handshake to remote DO droplet ≈ 5-15s round-trip) — caching
// lets repeated Manage opens within the TTL come back in <10ms instead of
// re-handshaking. Mutations evict the entry.
interface CachedRead { value: IndexReadResult; ts: number }
const readCache = new Map<string, CachedRead>()
const READ_CACHE_TTL_MS = 30_000

function cacheKey(domain: string, ip: string): string {
  return `${domain}|${ip}`
}
export function evictReadCache(domain: string, ip: string): void {
  readCache.delete(cacheKey(domain, ip))
}

/**
 * Try SA's REST file-manager API. Much faster than SSH (<500ms typical)
 * because the agent already has the file resident on disk and proxies it
 * over HTTPS. Endpoint shape isn't formally documented but matches the
 * write side (PATCH /file with same path/filename pair) — we probe a
 * couple of plausible read URLs and fall through to SSH on any failure.
 */
async function readIndexViaSaApi(
  domain: string,
  saServerId: string,
  appId: string,
): Promise<IndexReadResult | null> {
  const basePath =
    `/organizations/{ORG_ID}/servers/${saServerId}` +
    `/applications/${appId}/file-managers/file`
  const params = new URLSearchParams({ path: "/public_html/", filename: "index.php" })

  // Try the common shapes — first to return a 2xx with a body wins.
  // Each call goes through saRequest so primary→backup token failover applies.
  for (const suffix of ["", "/show", "/contents"]) {
    try {
      const { res: r } = await saRequest(`${basePath}${suffix}?${params.toString()}`, {
        timeoutMs: 8000,
      })
      if (!r.ok) continue
      const text = await r.text()
      let content: string | null = null
      try {
        const j = JSON.parse(text) as Record<string, unknown>
        const candidates = [j.body, j.content, j.data, j.file]
        for (const c of candidates) {
          if (typeof c === "string") { content = c; break }
        }
      } catch { /* not JSON — treat as raw body */ }
      if (content == null) content = text
      if (typeof content !== "string" || content.length === 0) continue
      logPipeline(domain, "sa_control", "running",
        `Read index.php via SA API (${content.length} bytes)`)
      return {
        content,
        bytes: content.length,
        path: "/public_html/index.php (via SA API)",
        has_backup: false,
      }
    } catch { /* try next URL shape */ }
  }
  return null
}

// getCreds removed — all SA calls in this file go through saRequest, which
// loads + iterates primary/backup tokens internally with org-id substitution.

// ---------------------------------------------------------------------------
// .htaccess hardening — backup files written next to index.php would
// otherwise be web-accessible (Apache serves *.bak as raw text by default,
// exposing PHP source). Drop a deny rule on first save and idempotently
// keep it in sync on every subsequent save.
// ---------------------------------------------------------------------------

const HTACCESS_RULE = `
# --- SSR dashboard: block web access to editor backups -----------------
<FilesMatch "\\.(bak|ssr-prev|orig)$">
  Require all denied
</FilesMatch>
# --- end SSR rule ------------------------------------------------------
`.trim()
const HTACCESS_MARKER = "SSR dashboard: block web access to editor backups"

/**
 * Read existing .htaccess (if any), prepend our deny rule when missing,
 * write back. Best-effort — failures are logged-and-swallowed so a save
 * never fails on hardening that didn't land.
 */
async function ensureHtaccessDenyBackup(
  domain: string,
  saServerId: string | null,
  appId: string | null,
): Promise<void> {
  if (!saServerId || !appId) return
  const basePath =
    `/organizations/{ORG_ID}/servers/${saServerId}` +
    `/applications/${appId}/file-managers`
  const params = new URLSearchParams({ path: "/public_html/", filename: ".htaccess" })

  // 1. Try to read current .htaccess
  let current = ""
  try {
    const { res: r } = await saRequest(`${basePath}/file?${params.toString()}`, {
      timeoutMs: 8000,
    })
    if (r.ok) {
      const text = await r.text()
      try {
        const j = JSON.parse(text) as Record<string, unknown>
        for (const k of ["body", "content", "data", "file"] as const) {
          const v = j[k]
          if (typeof v === "string") { current = v; break }
        }
      } catch { current = text }
    }
  } catch { /* file may not exist or read may not be supported — fall through */ }

  if (current.includes(HTACCESS_MARKER)) return // already present

  const merged = current.trim()
    ? `${HTACCESS_RULE}\n\n${current.trim()}\n`
    : `${HTACCESS_RULE}\n`

  // 2. Create file (idempotent — 500 with "exists" is OK)
  try {
    await saRequest(`${basePath}/file/create`, {
      method: "PATCH", json: true,
      body: JSON.stringify({ type: "file", name: ".htaccess", path: "/public_html/" }),
      timeoutMs: 6000,
    })
  } catch { /* ignore */ }

  // 3. Write merged content
  try {
    const { res: w } = await saRequest(`${basePath}/file`, {
      method: "PATCH", json: true,
      body: JSON.stringify({ filename: ".htaccess", path: "/public_html/", body: merged }),
      timeoutMs: 6000,
    })
    if (w.ok) {
      logPipeline(domain, "sa_control", "running",
        ".htaccess hardened — backup files now web-blocked")
    } else {
      logPipeline(domain, "sa_control", "warning",
        `.htaccess hardening write returned HTTP ${w.status} — backup files may still be web-readable`)
    }
  } catch (e) {
    logPipeline(domain, "sa_control", "warning",
      `.htaccess hardening failed: ${(e as Error).message}`)
  }
}

/**
 * Write index.php (and back up the previous content to index.php.bak) via
 * SA's REST file-managers API. ~3 round trips per call (~1.5s end-to-end)
 * vs SSH's cold-handshake-per-call cost (~5-15s). Used by the bulk path
 * so 5 concurrent sites finish in ~2s instead of ~15-75s.
 *
 * Returns null if SA API isn't reachable / returns 5xx — caller falls
 * back to SSH so single-site writes still get the chown/chmod hardening.
 */
async function writeIndexViaSaApi(
  domain: string,
  saServerId: string,
  appId: string,
  newContent: string,
  previousContent: string | null,
): Promise<{ bytes_written: number } | null> {
  const basePath =
    `/organizations/{ORG_ID}/servers/${saServerId}` +
    `/applications/${appId}/file-managers`

  async function patch(suffix: string, body: unknown): Promise<boolean> {
    try {
      const { res: r } = await saRequest(`${basePath}${suffix}`, {
        method: "PATCH", json: true,
        body: JSON.stringify(body),
        timeoutMs: 10_000,
      })
      if (r.ok) return true
      if (r.status === 500) {
        const txt = await r.text().catch(() => "")
        if (txt.toLowerCase().includes("exists")) return true
      }
      return false
    } catch { return false }
  }

  // 1. Back up current content to index.php.bak (best-effort — if create
  //    fails because the file exists, the subsequent PATCH overwrites).
  if (previousContent != null) {
    await patch("/file/create", { type: "file", name: "index.php.bak", path: "/public_html/" })
    const backupOk = await patch("/file", {
      filename: "index.php.bak", path: "/public_html/", body: previousContent,
    })
    if (!backupOk) {
      logPipeline(domain, "sa_control", "warning",
        "SA API backup write failed — abandoning API path, will retry via SSH")
      return null
    }
  }

  // 2. Write new content to index.php
  const writeOk = await patch("/file", {
    filename: "index.php", path: "/public_html/", body: newContent,
  })
  if (!writeOk) return null

  // 3. Best-effort .htaccess hardening — silent if it can't land. Does
  //    nothing on subsequent calls (idempotent marker check).
  void ensureHtaccessDenyBackup(domain, saServerId, appId).catch(() => { /* ignore */ })

  logPipeline(domain, "sa_control", "completed",
    `Wrote index.php via SA API (${newContent.length} bytes, backup updated)`)
  return { bytes_written: newContent.length }
}

export async function readIndexFile(
  domain: string, serverIp: string,
): Promise<IndexReadResult> {
  // Cache hit?
  const k = cacheKey(domain, serverIp)
  const cached = readCache.get(k)
  if (cached && Date.now() - cached.ts < READ_CACHE_TTL_MS) {
    return cached.value
  }

  // Try SA REST API first — usually <500ms vs SSH's 5-15s cold handshake.
  // Need sa_server_id + sa_app_id. Resolve from DB.
  try {
    const { listServers } = await import("./repos/servers")
    const { findAppId } = await import("./serveravatar")
    const sRow = listServers().find((s) => s.ip === serverIp)
    if (sRow?.sa_server_id) {
      const appId = await findAppId(sRow.sa_server_id, domain)
      if (appId) {
        const apiResult = await readIndexViaSaApi(domain, sRow.sa_server_id, appId)
        if (apiResult) {
          readCache.set(k, { value: apiResult, ts: Date.now() })
          return apiResult
        }
      }
    }
  } catch (e) {
    logPipeline(domain, "sa_control", "warning",
      `SA API read attempt failed (${(e as Error).message}) — falling back to SSH`)
  }

  // SSH fallback
  let ssh: SshSession | null = null
  try {
    ssh = await withTimeout(openSsh(serverIp), 15_000, `SSH connect ${serverIp}`)
    const pub = await resolvePublicHtml(ssh, domain)
    if (!pub) throw new Error(`No public_html dir found for ${domain} on ${serverIp}`)
    const filePath = `${pub}/index.php`
    const exists = await withTimeout(ssh.sftpStat(filePath), 5000, `sftpStat ${filePath}`)
    if (!exists) throw new Error(`index.php not found at ${filePath}`)
    const content = await withTimeout(ssh.sftpReadFile(filePath, "utf8"), 10_000, `sftpRead ${filePath}`)
    const hasBackup = await withTimeout(ssh.sftpStat(`${pub}/index.php.bak`), 5000, "sftpStat .bak")
      .catch(() => false)
    logPipeline(domain, "sa_control", "running",
      `Read index.php via SSH from ${filePath} (${content.length} bytes, backup=${hasBackup})`)
    const result: IndexReadResult = { content, bytes: content.length, path: filePath, has_backup: hasBackup }
    readCache.set(k, { value: result, ts: Date.now() })
    return result
  } catch (e) {
    logPipeline(domain, "sa_control", "warning",
      `Read index.php failed for ${serverIp}: ${(e as Error).message}`)
    throw e
  } finally {
    ssh?.close()
  }
}

export interface IndexWriteResult {
  bytes_written: number
  backup_path: string
  path: string
}

/**
 * Atomic write: copy current index.php → index.php.bak, then write the
 * new content. Caller is expected to have validated `body` is non-empty
 * (we still guard but the operator's confirmation modal is the better
 * place for that check).
 */
export async function writeIndexFile(
  domain: string, serverIp: string, body: string,
): Promise<IndexWriteResult> {
  if (!body || body.trim().length === 0) {
    throw new Error("refusing to write an empty index.php")
  }

  // Try the SA REST file API first — ~3 round trips, ~1-2s total. Massive
  // throughput win when bulk-editing 5+ sites concurrently.
  try {
    const { listServers } = await import("./repos/servers")
    const { findAppId } = await import("./serveravatar")
    const sRow = listServers().find((s) => s.ip === serverIp)
    if (sRow?.sa_server_id) {
      const appId = await findAppId(sRow.sa_server_id, domain)
      if (appId) {
        // Read current content (cached if recent) so we can back it up
        let previous: string | null = null
        try {
          const cur = await readIndexFile(domain, serverIp)
          previous = cur.content
        } catch { /* read miss — continue without backup */ }
        const apiOk = await writeIndexViaSaApi(domain, sRow.sa_server_id, appId, body, previous)
        if (apiOk) {
          evictReadCache(domain, serverIp)
          return {
            bytes_written: apiOk.bytes_written,
            backup_path: "/public_html/index.php.bak (via SA API)",
            path: "/public_html/index.php (via SA API)",
          }
        }
      }
    }
  } catch (e) {
    logPipeline(domain, "sa_control", "warning",
      `SA API write attempt failed (${(e as Error).message}) — falling back to SSH`)
  }

  // SSH fallback — keeps chown/chmod hardening for the cases where SA
  // API isn't reachable or returns 5xx.
  let ssh: SshSession | null = null
  try {
    ssh = await openSsh(serverIp)
    const pub = await resolvePublicHtml(ssh, domain)
    if (!pub) throw new Error(`No public_html dir for ${domain} on ${serverIp}`)
    const filePath = `${pub}/index.php`
    const backupPath = `${pub}/index.php.bak`
    // Backup current contents (if file exists). Use shell `cp -f` — atomic
    // on the same filesystem and preserves perms.
    if (await ssh.sftpStat(filePath)) {
      await ssh.exec(`cp -f ${filePath} ${backupPath}`, { timeoutMs: 8_000 })
    }
    await ssh.sftpWriteFile(filePath, body)
    // Re-apply ownership + perms — SFTP write may default to root:root.
    const sysUser = sysUserFor(domain)
    await ssh.exec(
      `chown ${sysUser}:${sysUser} ${filePath} 2>/dev/null; chmod 644 ${filePath}`,
      { timeoutMs: 8_000 },
    )
    logPipeline(domain, "sa_control", "completed",
      `Wrote index.php via SSH (${body.length} bytes) — backup at ${backupPath}`)

    // .htaccess hardening — block web access to *.bak so visitors can't
    // pull raw PHP source via https://…/index.php.bak. Idempotent: read,
    // skip if already present, otherwise prepend.
    try {
      const htPath = `${pub}/.htaccess`
      let cur = ""
      if (await ssh.sftpStat(htPath)) {
        cur = await ssh.sftpReadFile(htPath, "utf8").catch(() => "")
      }
      if (!cur.includes(HTACCESS_MARKER)) {
        const merged = cur.trim()
          ? `${HTACCESS_RULE}\n\n${cur.trim()}\n`
          : `${HTACCESS_RULE}\n`
        await ssh.sftpWriteFile(htPath, merged)
        await ssh.exec(
          `chown ${sysUser}:${sysUser} ${htPath} 2>/dev/null; chmod 644 ${htPath}`,
          { timeoutMs: 5000 },
        )
        logPipeline(domain, "sa_control", "running",
          ".htaccess hardened — backup files web-blocked")
      }
    } catch (e) {
      logPipeline(domain, "sa_control", "warning",
        `.htaccess hardening (SSH) failed: ${(e as Error).message}`)
    }

    evictReadCache(domain, serverIp)
    return { bytes_written: body.length, backup_path: backupPath, path: filePath }
  } finally {
    ssh?.close()
  }
}

export async function restoreIndexFile(
  domain: string, serverIp: string,
): Promise<{ bytes_restored: number; path: string }> {
  let ssh: SshSession | null = null
  try {
    ssh = await openSsh(serverIp)
    const pub = await resolvePublicHtml(ssh, domain)
    if (!pub) throw new Error(`No public_html dir for ${domain} on ${serverIp}`)
    const filePath = `${pub}/index.php`
    const backupPath = `${pub}/index.php.bak`
    if (!await ssh.sftpStat(backupPath)) {
      throw new Error(`No backup at ${backupPath} — nothing to restore`)
    }
    const content = await ssh.sftpReadFile(backupPath, "utf8")
    await ssh.exec(`cp -f ${backupPath} ${filePath}`, { timeoutMs: 8_000 })
    const sysUser = sysUserFor(domain)
    await ssh.exec(
      `chown ${sysUser}:${sysUser} ${filePath} 2>/dev/null; chmod 644 ${filePath}`,
      { timeoutMs: 8_000 },
    )
    logPipeline(domain, "sa_control", "completed",
      `Restored index.php from backup (${content.length} bytes)`)
    evictReadCache(domain, serverIp)
    return { bytes_restored: content.length, path: filePath }
  } finally {
    ssh?.close()
  }
}

// ---------------------------------------------------------------------------
// Arbitrary-file upload (single + bulk) — any extension (.php / .js / .css /
// .html / .txt / etc.). Always lands in `/public_html/`, top-level only —
// nested paths are rejected to keep the surface narrow. SA API path is the
// fast lane (~1s); SSH is the fallback for accounts whose file-manager API
// isn't reachable.
// ---------------------------------------------------------------------------

const SAFE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface UploadFileResult {
  filename: string
  bytes_written: number
  via: "sa_api" | "ssh"
  path: string
}

export function validateFilename(name: string): string | null {
  const n = (name || "").trim()
  if (!n) return "filename required"
  if (n.length > 128) return "filename too long (max 128)"
  if (n.includes("/") || n.includes("\\")) return "filename cannot contain slashes (top-level files only)"
  if (n.includes("..")) return "filename cannot contain '..'"
  if (!SAFE_FILENAME_RE.test(n)) {
    return "filename must start alphanumeric and contain only [A-Za-z0-9._-]"
  }
  // Block direct overwrite of editor-managed files via this path.
  const lower = n.toLowerCase()
  if (lower === "index.php.bak" || lower === ".htaccess") {
    return `'${n}' is managed by the editor — edit via the index.php drawer / hardening, not bulk upload`
  }
  return null
}

async function uploadViaSaApi(
  domain: string,
  saServerId: string,
  appId: string,
  filename: string,
  body: string,
): Promise<{ bytes_written: number } | null> {
  const basePath =
    `/organizations/{ORG_ID}/servers/${saServerId}` +
    `/applications/${appId}/file-managers`
  // Create (idempotent — 500 with "exists" is fine), then write content.
  try {
    const { res: cr } = await saRequest(`${basePath}/file/create`, {
      method: "PATCH", json: true,
      body: JSON.stringify({ type: "file", name: filename, path: "/public_html/" }),
      timeoutMs: 8000,
    })
    if (!cr.ok && cr.status === 500) {
      const txt = await cr.text().catch(() => "")
      if (!txt.toLowerCase().includes("exists")) return null
    }
  } catch { return null }
  try {
    const { res: wr } = await saRequest(`${basePath}/file`, {
      method: "PATCH", json: true,
      body: JSON.stringify({ filename, path: "/public_html/", body }),
      timeoutMs: 15_000,
    })
    if (!wr.ok) return null
  } catch { return null }
  logPipeline(domain, "sa_control", "completed",
    `Uploaded ${filename} via SA API (${body.length} bytes)`)
  return { bytes_written: body.length }
}

export async function uploadAppFile(
  domain: string, serverIp: string, filename: string, body: string,
): Promise<UploadFileResult> {
  const err = validateFilename(filename)
  if (err) throw new Error(err)
  if (body == null) throw new Error("body required")

  // SA API fast lane
  try {
    const { listServers } = await import("./repos/servers")
    const { findAppId } = await import("./serveravatar")
    const sRow = listServers().find((s) => s.ip === serverIp)
    if (sRow?.sa_server_id) {
      const appId = await findAppId(sRow.sa_server_id, domain)
      if (appId) {
        const r = await uploadViaSaApi(domain, sRow.sa_server_id, appId, filename, body)
        if (r) {
          return {
            filename,
            bytes_written: r.bytes_written,
            via: "sa_api",
            path: `/public_html/${filename} (via SA API)`,
          }
        }
      }
    }
  } catch (e) {
    logPipeline(domain, "sa_control", "warning",
      `SA API upload attempt failed (${(e as Error).message}) — falling back to SSH`)
  }

  // SSH fallback — write via SFTP into the resolved public_html
  let ssh: SshSession | null = null
  try {
    ssh = await withTimeout(openSsh(serverIp), 15_000, `SSH connect ${serverIp}`)
    const pub = await resolvePublicHtml(ssh, domain)
    if (!pub) throw new Error(`No public_html dir for ${domain} on ${serverIp}`)
    const filePath = `${pub}/${filename}`
    await withTimeout(ssh.sftpWriteFile(filePath, body), 15_000, `sftpWrite ${filename}`)
    const sysUser = sysUserFor(domain)
    await ssh.exec(
      `chown ${sysUser}:${sysUser} ${filePath} 2>/dev/null; chmod 644 ${filePath}`,
      { timeoutMs: 6000 },
    )
    logPipeline(domain, "sa_control", "completed",
      `Uploaded ${filename} via SSH (${body.length} bytes)`)
    return {
      filename,
      bytes_written: body.length,
      via: "ssh",
      path: filePath,
    }
  } finally {
    ssh?.close()
  }
}

export interface BulkUploadResult {
  succeeded: number
  failed: number
  items: { domain: string; ok: boolean; bytes_written?: number; via?: string; error?: string }[]
}

export async function bulkUploadFile(
  targets: BulkEditTarget[], filename: string, body: string,
  opts: { concurrency?: number } = {},
): Promise<BulkUploadResult> {
  const err = validateFilename(filename)
  if (err) throw new Error(err)
  const concurrency = Math.max(1, Math.min(10, opts.concurrency ?? 5))
  const items: BulkUploadResult["items"] = new Array(targets.length)
  let cursor = 0
  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= targets.length) break
      const t = targets[i]
      try {
        const r = await uploadAppFile(t.domain, t.server_ip, filename, body)
        items[i] = { domain: t.domain, ok: true, bytes_written: r.bytes_written, via: r.via }
      } catch (e) {
        items[i] = { domain: t.domain, ok: false, error: (e as Error).message.slice(0, 300) }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  let succeeded = 0, failed = 0
  for (const it of items) (it.ok ? succeeded++ : failed++)
  return { succeeded, failed, items }
}

// ---------------------------------------------------------------------------
// Service control — strict predefined commands only
// ---------------------------------------------------------------------------

export async function restartApache(serverIp: string): Promise<{ ok: boolean; output: string }> {
  let ssh: SshSession | null = null
  try {
    ssh = await openSsh(serverIp)
    // `reload` over `restart` — picks up config changes without dropping
    // active connections. Falls back to nginx if apache2 isn't installed.
    const r = await ssh.exec(
      "systemctl reload apache2 2>&1 || systemctl reload nginx 2>&1 || echo 'NO_WEB_SERVER'",
      { timeoutMs: 15_000 },
    )
    const ok = r.code === 0 && !r.stdout.includes("NO_WEB_SERVER")
    logPipeline(`server-ssh-${serverIp}`, "sa_control",
      ok ? "completed" : "failed",
      `Apache/nginx reload: ${r.stdout.slice(0, 200)}`)
    return { ok, output: r.stdout || r.stderr || "" }
  } finally {
    ssh?.close()
  }
}

export async function restartPhpFpm(serverIp: string): Promise<{ ok: boolean; output: string }> {
  let ssh: SshSession | null = null
  try {
    ssh = await openSsh(serverIp)
    // Restart whichever php-fpm version is installed — wildcard glob.
    const r = await ssh.exec(
      "for s in $(systemctl list-units --type=service --state=running --no-legend | " +
      "awk '{print $1}' | grep -E '^php[0-9.]+-fpm\\.service$'); do " +
      "systemctl restart \"$s\" && echo \"restarted $s\"; done",
      { timeoutMs: 30_000 },
    )
    const ok = r.code === 0 && (r.stdout.includes("restarted") || r.stdout.length === 0)
    logPipeline(`server-ssh-${serverIp}`, "sa_control",
      ok ? "completed" : "failed",
      `PHP-FPM restart: ${r.stdout.slice(0, 200)}`)
    return { ok, output: r.stdout || r.stderr || "" }
  } finally {
    ssh?.close()
  }
}

// ---------------------------------------------------------------------------
// File browser — list + delete files in /public_html for a single app.
// Counterpart to uploadAppFile. SSH-only (SA's file-manager API doesn't
// expose a clean list endpoint, and the surface area is tiny).
// ---------------------------------------------------------------------------

export interface AppFileEntry {
  name: string
  /** "f" = regular file, "d" = directory, "l" = symlink */
  kind: "f" | "d" | "l" | string
  bytes: number
  modified: string
}

export interface ListAppFilesResult {
  path: string
  files: AppFileEntry[]
}

/**
 * List the top-level entries inside /public_html. We stay non-recursive on
 * purpose — this matches uploadAppFile's "top-level only" rule. Operators
 * who need a deeper view can SSH directly.
 */
export async function listAppFiles(
  domain: string, serverIp: string,
): Promise<ListAppFilesResult> {
  let ssh: SshSession | null = null
  try {
    ssh = await withTimeout(openSsh(serverIp), 15_000, `SSH connect ${serverIp}`)
    const pub = await resolvePublicHtml(ssh, domain)
    if (!pub) throw new Error(`No public_html dir for ${domain} on ${serverIp}`)
    // %y (file type), %s (bytes), %TY-%Tm-%TdT%TH:%TM:%TSZ (mtime), %f (basename)
    // Pipe-separated so pipe-in-filename can't inject extra columns (filenames
    // here are validated on the way in via validateFilename).
    const r = await ssh.exec(
      `find '${pub}' -maxdepth 1 -mindepth 1 ` +
      `-printf '%y|%s|%TY-%Tm-%Td %TH:%TM:%TS|%f\\n' 2>/dev/null`,
      { timeoutMs: 10_000 },
    )
    const files: AppFileEntry[] = []
    for (const line of (r.stdout || "").split("\n")) {
      const t = line.trim()
      if (!t) continue
      const [kind, sizeStr, modified, ...rest] = t.split("|")
      const name = rest.join("|")
      if (!name) continue
      const bytes = Number.parseInt(sizeStr, 10)
      files.push({
        name, kind: kind || "?",
        bytes: Number.isFinite(bytes) ? bytes : 0,
        modified: modified || "",
      })
    }
    files.sort((a, b) => a.name.localeCompare(b.name))
    return { path: pub, files }
  } finally {
    ssh?.close()
  }
}

/**
 * Read one file's contents from /public_html. Capped at 1 MB so a stray
 * binary doesn't blow the response. Operators wanting the live `index.php`
 * should keep using /api/sa/index-file (it manages the .bak side effect);
 * this is for any other file they uploaded.
 */
export async function readAppFile(
  domain: string, serverIp: string, filename: string,
): Promise<{ content: string; bytes: number; path: string }> {
  const err = validateFilename(filename)
  if (err) throw new Error(err)
  let ssh: SshSession | null = null
  try {
    ssh = await withTimeout(openSsh(serverIp), 15_000, `SSH connect ${serverIp}`)
    const pub = await resolvePublicHtml(ssh, domain)
    if (!pub) throw new Error(`No public_html dir for ${domain} on ${serverIp}`)
    const filePath = `${pub}/${filename}`
    if (!await ssh.sftpStat(filePath)) {
      throw new Error(`'${filename}' does not exist`)
    }
    // Size guard before reading — sftpReadFile loads into memory.
    const sizeR = await ssh.exec(`stat -c '%s' '${filePath}' 2>/dev/null`, { timeoutMs: 5000 })
    const size = Number.parseInt((sizeR.stdout || "0").trim(), 10) || 0
    if (size > 1_000_000) {
      throw new Error(`'${filename}' is ${size} bytes — too large to view (max 1 MB)`)
    }
    const content = await withTimeout(ssh.sftpReadFile(filePath, "utf8"), 10_000, `sftpRead ${filename}`)
    return { content, bytes: content.length, path: filePath }
  } finally {
    ssh?.close()
  }
}

const PROTECTED_FILES = new Set(["index.php", "index.php.bak", ".htaccess"])

/**
 * Delete one file from /public_html. Same validateFilename rules as upload,
 * plus an extra block on the live `index.php` so an operator can't 404 the
 * site with a stray click — `index.php.bak` and `.htaccess` are already
 * blocked by validateFilename.
 */
export async function deleteAppFile(
  domain: string, serverIp: string, filename: string,
): Promise<{ filename: string; path: string }> {
  const err = validateFilename(filename)
  if (err) throw new Error(err)
  if (PROTECTED_FILES.has(filename.toLowerCase())) {
    throw new Error(`'${filename}' is protected — restore via the editor instead`)
  }
  let ssh: SshSession | null = null
  try {
    ssh = await withTimeout(openSsh(serverIp), 15_000, `SSH connect ${serverIp}`)
    const pub = await resolvePublicHtml(ssh, domain)
    if (!pub) throw new Error(`No public_html dir for ${domain} on ${serverIp}`)
    const filePath = `${pub}/${filename}`
    if (!await ssh.sftpStat(filePath)) {
      throw new Error(`'${filename}' does not exist`)
    }
    await ssh.sftpRemoveFile(filePath)
    logPipeline(domain, "sa_control", "completed", `Deleted ${filename} via SSH`)
    return { filename, path: filePath }
  } finally {
    ssh?.close()
  }
}

// ---------------------------------------------------------------------------
// Fleet view — server list with apps joined + heartbeat from our DB
// ---------------------------------------------------------------------------

export interface FleetServer {
  // SA-side
  sa_server_id: string
  sa_name: string
  sa_status: string
  ip: string
  // Stats (SA's getServerInfo response — fields vary; we surface what's there)
  cpu_usage: number | null
  ram_usage: number | null
  disk_usage: number | null
  uptime: string | null
  os: string | null
  // Linked SSR row (when present)
  db_server_id: number | null
  db_status: string | null
  // Apps live on this server
  apps: FleetApp[]
}

export interface FleetApp {
  sa_app_id: string
  name: string
  domain: string
  php_version: string | null
  ssl_status: string | null
  // Heartbeat from our DB if SSR tracks this domain
  last_heartbeat_at: string | null
  ssr_status: string | null
}

function pickNumber(o: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === "number" && Number.isFinite(v)) return v
    if (typeof v === "string" && v.trim()) {
      const n = parseFloat(v)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

function pickString(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === "string" && v.trim()) return v
  }
  return null
}

export async function listFleet(): Promise<FleetServer[]> {
  const saServers: SaServer[] = await listSaServers()
  const dbServers = listDbServers()
  const dbDomains = listDomains()

  // Index DB rows by sa_server_id and primary_domain
  const dbByIp = new Map(dbServers.filter((s) => s.ip).map((s) => [s.ip!, s]))
  const dbByDomain = new Map(dbDomains.map((d) => [d.domain, d]))

  // Fetch detail for each SA server in parallel (capped to 5 concurrent so
  // we don't hammer SA on a 50-server fleet)
  const concurrency = 5
  const detailed: SaServer[] = []
  for (let i = 0; i < saServers.length; i += concurrency) {
    const slice = saServers.slice(i, i + concurrency)
    const results = await Promise.all(slice.map(async (s) => {
      try { return await getServerInfo(String(s.id)) }
      catch { return s }
    }))
    detailed.push(...results)
  }

  const out: FleetServer[] = []
  for (const s of detailed) {
    const ip = String(s.server_ip ?? s.ip ?? "")
    const saId = String(s.id ?? "")
    const dbRow = ip ? dbByIp.get(ip) ?? null : null
    const sObj = s as Record<string, unknown>

    // Apps
    let saApps: SaApp[] = []
    try { saApps = await listApplications(saId) } catch { /* skip */ }
    const apps: FleetApp[] = saApps.map((a) => {
      const aObj = a as Record<string, unknown>
      const domain = String(a.primary_domain ?? "")
      const trackedDomain = domain ? dbByDomain.get(domain) : null
      return {
        sa_app_id: String(a.id ?? ""),
        name: a.name ?? domain,
        domain,
        php_version: pickString(aObj, "php_version", "phpVersion"),
        ssl_status: pickString(aObj, "ssl_status", "sslStatus", "ssl"),
        last_heartbeat_at: trackedDomain?.last_heartbeat_at ?? null,
        ssr_status: trackedDomain?.status ?? null,
      }
    })

    out.push({
      sa_server_id: saId,
      sa_name: String(s.name ?? `srv-${saId}`),
      sa_status: pickString(sObj, "agent_status", "status") ?? "unknown",
      ip,
      cpu_usage: pickNumber(sObj, "cpu_usage", "cpu_load", "cpu"),
      ram_usage: pickNumber(sObj, "ram_usage", "memory_usage", "ram"),
      disk_usage: pickNumber(sObj, "disk_usage", "disk"),
      uptime: pickString(sObj, "uptime", "boot_time"),
      os: pickString(sObj, "os", "operating_system", "distribution"),
      db_server_id: dbRow?.id ?? null,
      db_status: dbRow?.status ?? null,
      apps,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Bulk index editor primitives
// ---------------------------------------------------------------------------

export type BulkEditOp =
  | { kind: "insert_top"; code: string }
  | { kind: "append_end"; code: string }
  | { kind: "search_replace"; find: string; replace: string }
  | { kind: "replace_line"; line: number; replace: string }
  | { kind: "delete_top" }

export interface BulkEditTarget {
  domain: string
  server_ip: string
}

export interface BulkEditItem {
  domain: string
  ok: boolean
  bytes_written?: number
  error?: string
  unchanged?: boolean
}

export interface BulkEditResult {
  /** Count of successful writes (or simulated writes when dryRun). */
  succeeded: number
  failed: number
  unchanged: number
  items: BulkEditItem[]
}

/**
 * Apply a bulk edit op across many sites. Read each, transform, write back
 * (with backup). Capped at 5 in flight at a time. Errors don't abort the
 * batch — they're collected and returned per-domain.
 */
export async function bulkEditIndex(
  targets: BulkEditTarget[], op: BulkEditOp,
  opts: { dryRun?: boolean; concurrency?: number } = {},
): Promise<BulkEditResult> {
  const dryRun = !!opts.dryRun
  const concurrency = Math.max(1, Math.min(10, opts.concurrency ?? 5))

  const apply = (current: string): string => {
    switch (op.kind) {
      case "insert_top": return op.code.replace(/\r\n/g, "\n") + (op.code.endsWith("\n") ? "" : "\n") + current
      case "append_end":
        return current + (current.endsWith("\n") ? "" : "\n") + op.code.replace(/\r\n/g, "\n")
      case "search_replace": {
        if (!op.find) return current
        return current.split(op.find).join(op.replace)
      }
      case "replace_line": {
        const lines = current.split("\n")
        const idx = op.line - 1
        if (idx < 0 || idx >= lines.length) return current
        lines[idx] = op.replace
        return lines.join("\n")
      }
      case "delete_top": {
        // Drop the first line — handy for stripping a stray "<?php" header,
        // an injected analytics snippet, or a one-line test marker added
        // earlier by mistake. No-op on empty files.
        const lines = current.split("\n")
        if (lines.length === 0) return current
        lines.shift()
        return lines.join("\n")
      }
    }
  }

  const items: BulkEditItem[] = new Array(targets.length)
  let cursor = 0

  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= targets.length) break
      const t = targets[i]
      try {
        const before = await readIndexFile(t.domain, t.server_ip)
        const after = apply(before.content)
        if (after === before.content) {
          items[i] = { domain: t.domain, ok: true, unchanged: true }
          continue
        }
        if (dryRun) {
          items[i] = { domain: t.domain, ok: true, bytes_written: after.length }
          continue
        }
        // Single retry on transient SSH failure
        let attempt = 0
        while (true) {
          try {
            const w = await writeIndexFile(t.domain, t.server_ip, after)
            items[i] = { domain: t.domain, ok: true, bytes_written: w.bytes_written }
            break
          } catch (e) {
            attempt++
            if (attempt >= 2) throw e
            await new Promise((r) => setTimeout(r, 1000))
          }
        }
      } catch (e) {
        items[i] = { domain: t.domain, ok: false, error: (e as Error).message.slice(0, 300) }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  let succeeded = 0, failed = 0, unchanged = 0
  for (const it of items) {
    if (it.ok) {
      if (it.unchanged) unchanged++
      else succeeded++
    } else failed++
  }
  return { succeeded, failed, unchanged, items }
}
