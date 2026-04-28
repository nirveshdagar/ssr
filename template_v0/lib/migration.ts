/**
 * Phase B+ migration support — Node port of modules/migration.py.
 *
 * Two surfaces in one module:
 *   Phase 1 (active today, called from pipeline.ts step 7/8/10 hooks):
 *     - archiveSite / readArchive / deleteArchive
 *     - captureCfRecordIds
 *     - saveOriginCert
 *     - patchCfARecords
 *   Phase 2 (dead-server migration — Flask itself is not fully exercising):
 *     - migrateDomain(domain, newServer)
 *     - migrateServer(oldId, newId?)
 *
 * Archive layout matches Flask exactly so both apps can read each other's
 * archives:
 *   data/site_archives/{domain}.tar.gz
 *     ├─ index.php       (PHP from step 9 / what step 10 uploads)
 *     └─ metadata.json   (niche, generated_at, bytes, sha256)
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, unlinkSync, readFileSync } from "node:fs"
import path from "node:path"
import { getDomain, listDomains, updateDomain } from "./repos/domains"
import { listServers } from "./repos/servers"
import { logPipeline } from "./repos/logs"

const ARCHIVE_DIR_REL = path.join("data", "site_archives")

function archiveDir(): string {
  // Same path-resolution rule as db.ts so Flask + Node share the dir
  if (process.env.SSR_DB_PATH) {
    return path.join(path.dirname(process.env.SSR_DB_PATH), "site_archives")
  }
  return path.resolve(process.cwd(), "..", ARCHIVE_DIR_REL)
}

const DOMAIN_PATH_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

function archivePath(domain: string): string {
  const d = (domain || "").trim().toLowerCase()
  if (!d || d.length > 253 || !DOMAIN_PATH_RE.test(d)) {
    throw new Error(`refuse to build archive path for invalid domain: ${JSON.stringify(domain)}`)
  }
  return path.join(archiveDir(), `${d}.tar.gz`)
}

// ---------------------------------------------------------------------------
// Archive read / write — gzipped tar, two entries (index.php + metadata.json)
// ---------------------------------------------------------------------------

interface ArchiveMetadata {
  domain: string
  generated_at: string
  bytes: number
  sha256: string
  [k: string]: unknown
}

/**
 * Pack an in-memory tarball with two entries. Uses tar.create({ file: ... })
 * which is intended for filesystem files, but we can pass virtual entries
 * via tar.Pack with synthetic readables. Easier: write the two files to a
 * temp dir then tar them. Cleanest: hand-roll a tar header (USTAR is simple).
 *
 * I'm going hand-rolled — the format is dead simple, no external moving
 * parts, and matches Python's tarfile exactly when all fields are populated.
 */
function packTarGz(files: { name: string; content: Buffer; mtime: number }[]): Buffer {
  const blocks: Buffer[] = []
  for (const f of files) {
    blocks.push(buildTarHeader(f.name, f.content.length, f.mtime))
    blocks.push(f.content)
    const pad = (512 - (f.content.length % 512)) % 512
    if (pad > 0) blocks.push(Buffer.alloc(pad))
  }
  // Two empty 512-byte blocks signal end-of-archive
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function buildTarHeader(name: string, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(512)
  // Name (offset 0, 100 bytes)
  h.write(name, 0, 100, "ascii")
  // Mode (100, 8) — "0000644 \0"
  h.write("0000644\0", 100, 8, "ascii")
  // UID (108, 8), GID (116, 8)
  h.write("0000000\0", 108, 8, "ascii")
  h.write("0000000\0", 116, 8, "ascii")
  // Size (124, 12) — octal, 11 chars + null
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii")
  // Mtime (136, 12)
  h.write(mtime.toString(8).padStart(11, "0") + "\0", 136, 12, "ascii")
  // Checksum placeholder (148, 8) — fill with spaces for now
  h.write("        ", 148, 8, "ascii")
  // Typeflag (156, 1) — "0" = regular file
  h.write("0", 156, 1, "ascii")
  // Magic + version (257, 8) — USTAR
  h.write("ustar\x0000", 257, 8, "ascii")
  // Compute checksum: sum of all 512 bytes interpreted as unsigned
  let sum = 0
  for (let i = 0; i < 512; i++) sum += h[i]
  // Write checksum as 6-digit octal + null + space (POSIX format)
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii")
  return h
}

async function gzip(buf: Buffer): Promise<Buffer> {
  const { gzip } = await import("node:zlib")
  return new Promise((resolve, reject) => {
    gzip(buf, (err, out) => (err ? reject(err) : resolve(out)))
  })
}

async function gunzip(buf: Buffer): Promise<Buffer> {
  const { gunzip } = await import("node:zlib")
  return new Promise((resolve, reject) => {
    gunzip(buf, (err, out) => (err ? reject(err) : resolve(out)))
  })
}

function readTarEntries(tarBytes: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let off = 0
  while (off + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(off, off + 512)
    // End-of-archive: zero block
    if (header.every((b) => b === 0)) break
    const name = header.subarray(0, 100).toString("ascii").replace(/\0.*$/, "")
    const sizeStr = header.subarray(124, 136).toString("ascii").replace(/[\0 ]+$/, "")
    const size = parseInt(sizeStr, 8) || 0
    off += 512
    if (size > 0) {
      out.set(name, tarBytes.subarray(off, off + size))
      off += size
      const pad = (512 - (size % 512)) % 512
      off += pad
    }
  }
  return out
}

export async function archiveSite(
  domain: string, phpContent: string, metadata: Record<string, unknown> = {},
): Promise<string> {
  const dir = archiveDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const phpBytes = Buffer.from(phpContent, "utf8")
  const meta: ArchiveMetadata = {
    domain,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    bytes: phpBytes.length,
    sha256: createHash("sha256").update(phpBytes).digest("hex"),
    ...metadata,
  }
  const metaBytes = Buffer.from(JSON.stringify(meta, null, 2), "utf8")
  const now = Math.floor(Date.now() / 1000)
  const tarBytes = packTarGz([
    { name: "index.php", content: phpBytes, mtime: now },
    { name: "metadata.json", content: metaBytes, mtime: now },
  ])
  const gz = await gzip(tarBytes)
  const p = archivePath(domain)
  const { writeFileSync } = await import("node:fs")
  writeFileSync(p, gz)

  updateDomain(domain, { content_archive_path: p } as Parameters<typeof updateDomain>[1])
  logPipeline(domain, "archive", "completed",
    `Site archived (${gz.length} bytes → ${p})`)
  return p
}

export async function readArchive(domain: string): Promise<{ php: string; meta: ArchiveMetadata } | null> {
  const d = getDomain(domain)
  const p = d?.content_archive_path ?? archivePath(domain)
  if (!existsSync(p)) return null
  const gz = readFileSync(p)
  const tarBytes = await gunzip(gz)
  const entries = readTarEntries(tarBytes)
  const phpBuf = entries.get("index.php")
  if (!phpBuf) return null
  const php = phpBuf.toString("utf8")
  let meta: ArchiveMetadata = { domain, generated_at: "", bytes: phpBuf.length, sha256: "" }
  const metaBuf = entries.get("metadata.json")
  if (metaBuf) {
    try { meta = { ...meta, ...JSON.parse(metaBuf.toString("utf8")) } } catch { /* ignore */ }
  }
  return { php, meta }
}

export function deleteArchive(domain: string): boolean {
  let p: string
  try { p = archivePath(domain) } catch { return false }
  if (!existsSync(p)) return false
  try {
    unlinkSync(p)
    logPipeline(domain, "archive", "completed", `Archive removed: ${p}`)
    return true
  } catch (e) {
    logPipeline(domain, "archive", "warning", `Archive delete failed: ${(e as Error).message}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// CF record-ID cache + fast IP patch
// ---------------------------------------------------------------------------

export async function captureCfRecordIds(domain: string): Promise<{ a: string | null; www: string | null }> {
  const d = getDomain(domain)
  if (!d || !d.cf_zone_id) {
    throw new Error(`${domain}: no cf_zone_id in DB — zone not created yet?`)
  }
  if (!d.cf_email || !d.cf_global_key) {
    throw new Error(`${domain}: no CF credentials on row`)
  }
  const captured: { a: string | null; www: string | null } = { a: null, www: null }
  const headers = {
    "X-Auth-Email": d.cf_email,
    "X-Auth-Key": d.cf_global_key,
    "Content-Type": "application/json",
  }
  for (const [name, key] of [[domain, "a"], [`www.${domain}`, "www"]] as const) {
    const url = `https://api.cloudflare.com/client/v4/zones/${d.cf_zone_id}/dns_records` +
                `?type=A&name=${encodeURIComponent(name)}`
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
    if (!r.ok) throw new Error(`CF dns_records HTTP ${r.status}`)
    const j = (await r.json()) as { result?: { id: string }[] }
    const results = j.result ?? []
    if (results.length) captured[key] = results[0].id
  }
  updateDomain(domain, {
    cf_a_record_id: captured.a,
    cf_www_record_id: captured.www,
  } as Parameters<typeof updateDomain>[1])
  logPipeline(domain, "cf_record_capture", "completed",
    `Cached A-record IDs: apex=${captured.a} www=${captured.www}`)
  return captured
}

export function saveOriginCert(domain: string, certPem: string, keyPem: string): void {
  updateDomain(domain, {
    origin_cert_pem: certPem,
    origin_key_pem: keyPem,
  } as Parameters<typeof updateDomain>[1])
  logPipeline(domain, "origin_cert_cache", "completed",
    `Cached Origin CA cert (${certPem.length}B) + key (${keyPem.length}B)`)
}

export async function patchCfARecords(
  domain: string, newIp: string,
): Promise<{ a: boolean; www: boolean }> {
  const d = getDomain(domain)
  if (!d) throw new Error(`${domain}: no DB row`)
  if (!d.cf_zone_id || !d.cf_email || !d.cf_global_key) {
    throw new Error(`${domain}: missing CF zone/credentials`)
  }
  const result = { a: false, www: false }
  const headers = {
    "X-Auth-Email": d.cf_email,
    "X-Auth-Key": d.cf_global_key,
    "Content-Type": "application/json",
  }
  const cfApi = "https://api.cloudflare.com/client/v4"

  for (const [recCol, name, key] of [
    ["cf_a_record_id", domain, "a"],
    ["cf_www_record_id", `www.${domain}`, "www"],
  ] as const) {
    let recId = (d[recCol] as string | null) ?? null
    if (!recId) {
      // Fallback: list+search
      const url = `${cfApi}/zones/${d.cf_zone_id}/dns_records?type=A&name=${encodeURIComponent(name)}`
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
      if (r.ok) {
        const j = (await r.json()) as { result?: { id: string }[] }
        if (j.result?.length) recId = j.result[0].id
      }
    }
    if (!recId) {
      logPipeline(domain, "migrate_dns", "warning", `No ${name} A record to patch`)
      continue
    }
    const pr = await fetch(
      `${cfApi}/zones/${d.cf_zone_id}/dns_records/${recId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ content: newIp }),
        signal: AbortSignal.timeout(30_000),
      },
    )
    if (pr.ok) {
      try {
        const j = (await pr.json()) as { success?: boolean }
        result[key] = Boolean(j.success)
      } catch { /* ignore */ }
    }
  }
  const allOk = result.a && result.www
  logPipeline(domain, "migrate_dns", allOk ? "completed" : "warning",
    `CF A-records → ${newIp}  apex=${result.a} www=${result.www}`)
  return result
}

// ---------------------------------------------------------------------------
// Phase 2 — migrate_domain / migrate_server
// ---------------------------------------------------------------------------

interface MigrateDomainResult { ok: boolean; message: string }

export interface ServerLike {
  id: number
  ip: string | null
  sa_server_id: string | null
}

async function lazyImports() {
  const sa = await import("./serveravatar")
  const cf = await import("./cloudflare")
  return { sa, cf }
}

export async function migrateDomain(
  domain: string, newServer: ServerLike,
): Promise<MigrateDomainResult> {
  const d = getDomain(domain)
  if (!d) return { ok: false, message: `${domain}: no DB row` }
  if (!d.cf_zone_id) return { ok: false, message: `${domain}: no CF zone — cannot migrate` }
  if (!newServer || !newServer.sa_server_id) {
    return { ok: false, message: `${domain}: new_server has no sa_server_id` }
  }
  if (!newServer.ip) {
    return { ok: false, message: `${domain}: new_server has no IP` }
  }

  // Avoid colliding with a pipeline / teardown for the same domain
  const { isPipelineRunning } = await import("./pipeline")
  if (isPipelineRunning(domain)) {
    return {
      ok: false,
      message: `${domain}: another worker (pipeline/teardown) is running — skipped`,
    }
  }

  const oldServerId = d.server_id
  const newSaId = newServer.sa_server_id!
  const newIp = newServer.ip!
  const newIdNum = newServer.id

  logPipeline(domain, "migrate", "running",
    `Starting migration → server #${newIdNum} (${newIp})`)

  // Heartbeat ticker — pulses last_heartbeat_at every 1s so the watcher
  // proves the migrator is still alive during slow steps (SA app create
  // ~5–15s, SSL install ~15–30s, content upload ~5s).
  const { startHeartbeat } = await import("./repos/steps")
  const ticker = startHeartbeat(domain, 1000)

  const { sa, cf } = await lazyImports()

  try {
    // 1. Create SA app on new server
    let appId: string
    try {
      appId = await sa.createApplication(newSaId, domain)
    } catch (e) {
      const found = await sa.findAppId(newSaId, domain)
      if (!found) {
        const msg = `SA createApplication: ${(e as Error).message}`
        logPipeline(domain, "migrate", "failed", msg)
        return { ok: false, message: `SA app create failed: ${(e as Error).message}` }
      }
      logPipeline(domain, "migrate", "running",
        `SA app already existed (id=${found}) — reusing`)
      appId = found
    }

    // 2. Install SSL — prefer cached cert
    let certPem = d.origin_cert_pem ?? ""
    let keyPem = d.origin_key_pem ?? ""
    if (!certPem || !keyPem) {
      logPipeline(domain, "migrate", "running",
        "No cached Origin cert — re-issuing from Cloudflare...")
      try {
        const bundle = await cf.fetchOriginCaCert(domain)
        certPem = bundle.certificate
        keyPem = bundle.private_key
        saveOriginCert(domain, certPem, keyPem)
      } catch (e) {
        logPipeline(domain, "migrate", "failed",
          `Origin cert fetch: ${(e as Error).message}`)
        return { ok: false, message: `cert fetch failed: ${(e as Error).message}` }
      }
    }

    // Grey-cloud briefly so SA's install flow sees the origin
    try {
      await cf.setDnsARecord(domain, newIp, false)
      await cf.setDnsARecordWww(domain, newIp, false)
    } catch (e) {
      logPipeline(domain, "migrate", "warning",
        `grey-cloud pre-install: ${(e as Error).message}`)
    }

    let installOk = false
    let installMsg = ""
    try {
      const r = await sa.installCustomSsl({
        saServerId: newSaId,
        appId,
        certificatePem: certPem,
        privateKeyPem: keyPem,
        chainPem: "",
        forceHttps: true,
        domain,
        serverIp: newIp,
      })
      installOk = r.ok
      installMsg = r.message
    } catch (e) {
      installMsg = `install error: ${(e as Error).message}`
    } finally {
      // Restore orange cloud
      try {
        await cf.setDnsARecord(domain, newIp, true)
        await cf.setDnsARecordWww(domain, newIp, true)
      } catch (e) {
        logPipeline(domain, "migrate", "warning",
          `orange-cloud restore: ${(e as Error).message}`)
      }
    }
    if (!installOk) {
      logPipeline(domain, "migrate", "failed", `SSL install: ${installMsg}`)
      return { ok: false, message: `SSL install failed: ${installMsg}` }
    }

    // 3. Upload content from archive (or DB fallback)
    let php: string | null = null
    try {
      const archived = await readArchive(domain)
      if (archived) php = archived.php
    } catch (e) {
      logPipeline(domain, "migrate", "warning",
        `archive read: ${(e as Error).message}  — will try DB fallback`)
    }
    if (!php) php = d.site_html ?? null
    if (!php || php.length < 50) {
      logPipeline(domain, "migrate", "failed",
        "No archive AND no site_html in DB — cannot migrate content")
      return { ok: false, message: "no archived content to upload" }
    }

    try {
      await sa.uploadIndexPhp(newSaId, domain, php)
    } catch (e) {
      logPipeline(domain, "migrate", "failed",
        `upload_index_php: ${(e as Error).message}`)
      return { ok: false, message: `content upload failed: ${(e as Error).message}` }
    }

    // 4. PATCH CF A-records to new IP
    try {
      await patchCfARecords(domain, newIp)
    } catch (e) {
      logPipeline(domain, "migrate", "warning",
        `CF record patch: ${(e as Error).message}  — DNS may be stale`)
    }
    try { await captureCfRecordIds(domain) } catch { /* ignore */ }

    // 5. Update domain row
    updateDomain(domain, {
      server_id: newIdNum,
      current_proxy_ip: newIp,
      status: "hosted",
    })

    // 6. Best-effort delete on old server
    if (oldServerId && oldServerId !== newIdNum) {
      const old = listServers().find((s) => s.id === oldServerId)
      if (old?.sa_server_id) {
        try {
          await sa.deleteApplication(old.sa_server_id, domain)
          logPipeline(domain, "migrate", "running",
            `Deleted app from old server #${oldServerId}`)
        } catch (e) {
          logPipeline(domain, "migrate", "warning",
            `Old-server cleanup failed (expected if old server is dead): ` +
            `${(e as Error).message}`)
        }
      }
    }

    logPipeline(domain, "migrate", "completed",
      `Migrated to server #${newIdNum} (${newIp})`)
    return { ok: true, message: `migrated to #${newIdNum} (${newIp})` }
  } catch (e) {
    return { ok: false, message: `unhandled: ${(e as Error).message}` }
  } finally {
    ticker.stop()
  }
}

export interface MigrateServerResult {
  ok: string[]
  failed: { domain: string; reason: string }[]
  new_server_id: number | null
  msg: string
}

export async function migrateServer(
  oldServerId: number, newServerId?: number | null,
): Promise<MigrateServerResult> {
  const oldRows = listDomains().filter((d) => d.server_id === oldServerId)
  if (oldRows.length === 0) {
    return {
      ok: [], failed: [], new_server_id: null,
      msg: `No domains on server #${oldServerId} — nothing to do`,
    }
  }

  // Multi-domain heartbeat ticker — pulses last_heartbeat_at on EVERY
  // migrated domain every 1s for the entire migrateServer lifetime, even
  // during the slow droplet-provisioning phase (5–15 min). Without this
  // the watcher would mark all rows stale during the long boot window
  // and operators would think the migration crashed.
  const { startHeartbeat } = await import("./repos/steps")
  const allDomains = oldRows.map((r) => r.domain)
  const ticker = startHeartbeat(allDomains, 1000)
  try {

  // Pick / provision target. Three tiers, in order:
  //   1. Caller-supplied newServerId (manual migrate-now with explicit pick)
  //   2. Any existing eligible ready server with capacity — SKIPPED entirely
  //      when settings.migrate_always_provision_new = "1" (operator preference
  //      for "always fresh droplet on a dead server, never reuse existing")
  //   3. Provision a fresh DO droplet + install SA agent (5–15 min)
  const { getSetting } = await import("./repos/settings")
  const alwaysProvision = (getSetting("migrate_always_provision_new") ?? "0") === "1"

  let target: ServerLike | null = null
  if (newServerId) {
    const s = listServers().find((x) => x.id === Number(newServerId))
    if (s) target = { id: s.id, ip: s.ip, sa_server_id: s.sa_server_id }
  } else if (!alwaysProvision) {
    const eligible = listServers().find(
      (s) => s.id !== oldServerId && s.status === "ready" && s.sa_server_id &&
        (s.sites_count ?? 0) < (s.max_sites ?? 60),
    )
    if (eligible) target = { id: eligible.id, ip: eligible.ip, sa_server_id: eligible.sa_server_id }
  }

  if (!target) {
    // No target supplied AND no existing server has capacity → auto-provision.
    // Mirrors Flask modules/migration.py migrate_server() lines 419-431. The
    // anchor domain is the first migrated row so log_pipeline events show up
    // on a real domain page; the new droplet hosts every migrated domain.
    const anchorName = oldRows[0]?.domain ?? "(auto-migrate)"
    logPipeline(anchorName, "migrate", "running",
      `No eligible target server — provisioning a fresh DO droplet (this takes 5–15 min)…`)
    try {
      const { createDroplet, DOAllTokensFailed, DropletRateLimited } =
        await import("./digitalocean")
      const { installAgentOnDroplet } = await import("./serveravatar")
      const { updateServer } = await import("./repos/servers")

      const { generateServerName } = await import("./server-names")
      const gen = await generateServerName()
      const newName = gen.name
      if (gen.lookup_errors.length > 0) {
        logPipeline(anchorName, "migrate", "warning",
          `Name picked '${newName}' but uniqueness lookup had errors: ` +
          gen.lookup_errors.map((e) => `${e.source}=${e.error.slice(0, 60)}`).join("; "))
      }
      const { serverId, ip: newIp, dropletId } = await createDroplet({ name: newName })
      logPipeline(anchorName, "migrate", "running",
        `Droplet ${dropletId} up at ${newIp} — installing SA agent (~5–15 min)…`)
      const newSaId = await installAgentOnDroplet({ dropletIp: newIp, serverName: newName })
      updateServer(serverId, { sa_server_id: newSaId, status: "ready" })
      target = { id: serverId, ip: newIp, sa_server_id: newSaId }
      logPipeline(anchorName, "migrate", "running",
        `Provisioned server #${serverId} ${newName} (${newIp}) — beginning migration`)

      // Notify the operator that a new server was created automatically
      try {
        const { notify } = await import("./notify")
        await notify(
          `Auto-provisioned new server #${serverId}`,
          `Migration off server #${oldServerId} had no eligible target. ` +
          `New droplet ${newName} (${newIp}) was created and the SA agent installed. ` +
          `Migrating ${oldRows.length} domain(s) onto it now.`,
          { severity: "warning", dedupeKey: `auto_provision:${oldServerId}` },
        )
      } catch { /* notify is best-effort */ }
    } catch (e) {
      // Three failure modes:
      //   DOAllTokensFailed — DO rejected both tokens, nothing we can do
      //   DropletRateLimited — local cost cap, refuses provisioning
      //   anything else — SSH/install timeout, unexpected
      const { DOAllTokensFailed, DropletRateLimited } =
        await import("./digitalocean")
      let reason: string
      if (e instanceof DOAllTokensFailed) {
        reason = `DO tokens all failed: ${e.attempts.map(([l, m]) => `${l}→${m}`).join("; ")}`
      } else if (e instanceof DropletRateLimited) {
        reason = `cost cap hit: ${e.message}`
      } else {
        reason = `auto-provision: ${(e as Error).message}`
      }
      logPipeline(anchorName, "migrate", "failed", reason)
      try {
        const { notify } = await import("./notify")
        await notify(
          `Auto-migrate FAILED for server #${oldServerId}`,
          `Could not auto-provision a replacement: ${reason}\n\n` +
          `Affected domains: ${oldRows.map((r) => r.domain).join(", ")}\n\n` +
          `Manual action required — fix the cause then click Migrate Now on the dashboard.`,
          { severity: "error", dedupeKey: `auto_migrate_fail:${oldServerId}` },
        )
      } catch { /* ignore */ }
      return {
        ok: [],
        failed: oldRows.map((r) => ({ domain: r.domain, reason })),
        new_server_id: null,
        msg: `Auto-provision failed: ${reason}`,
      }
    }
  }

  const ok: string[] = []
  const failed: { domain: string; reason: string }[] = []
  for (const row of oldRows) {
    try {
      const result = await migrateDomain(row.domain, target)
      if (result.ok) ok.push(row.domain)
      else failed.push({ domain: row.domain, reason: result.message })
    } catch (e) {
      failed.push({ domain: row.domain, reason: `unhandled: ${(e as Error).message}` })
    }
  }
  return {
    ok, failed,
    new_server_id: target.id,
    msg: `Migrated ${ok.length}/${oldRows.length} domains from #${oldServerId} → #${target.id}`,
  }
  } finally {
    ticker.stop()
  }
}

