/**
 * Job handler: operator-initiated bulk migration of selected domains to a
 * chosen target server. Each domain goes through the standard migrateDomain
 * primitive (delete from old server's SA → create on target's SA → patch CF
 * A-records to target IP → re-deploy cached cert + index.php from the local
 * archive) so the original CF zone, NS, and registrar settings stay intact.
 *
 * Three target modes — same shape as the run-pipeline dialog:
 *   target_server_id=<N>      → migrate every domain to that specific server
 *   force_new_server=true     → provision a fresh DO droplet, then migrate
 *   (neither)                 → round-robin to any 'ready' server with capacity
 *
 * Target resolution is shared between modes, then the loop is sequential
 * per-domain (each migrateDomain call is ~30s for the SSL re-install +
 * content upload). Heartbeat ticker pulses every domain's row throughout
 * the whole job so the watcher doesn't mark them stale during slow steps.
 */

import { listDomains } from "../repos/domains"
import { listServers, updateServer } from "../repos/servers"
import { logPipeline } from "../repos/logs"
import { migrateDomain, type ServerLike } from "../migration"

interface BulkMigratePayload {
  domains: string[]
  target_server_id?: number | null
  force_new_server?: boolean
}

/**
 * Resolve target server given the three-mode policy. Pure async — does no DB
 * writes except as a side-effect of provisioning a new droplet (then it
 * writes the new servers row).
 */
async function resolveTarget(
  payload: BulkMigratePayload, anchorDomain: string,
): Promise<{ ok: true; target: ServerLike } | { ok: false; reason: string }> {
  // Mode 1: explicit target server id
  if (payload.target_server_id) {
    const s = listServers().find((x) => x.id === Number(payload.target_server_id))
    if (!s) return { ok: false, reason: `target server #${payload.target_server_id} not found` }
    if (!s.sa_server_id || !s.ip) {
      return { ok: false, reason: `target server #${s.id} has no sa_server_id or IP` }
    }
    if (s.status !== "ready") {
      return { ok: false, reason: `target server #${s.id} status='${s.status}' (not 'ready')` }
    }
    return { ok: true, target: { id: s.id, ip: s.ip, sa_server_id: s.sa_server_id } }
  }

  // Mode 2: provision a fresh DO droplet
  if (payload.force_new_server) {
    logPipeline(anchorDomain, "bulk_migrate", "running",
      "force_new_server=on — provisioning fresh DO droplet (5–15 min)…")
    try {
      const { createDroplet } = await import("../digitalocean")
      const { installAgentOnDroplet } = await import("../serveravatar")
      const newName = `ssr-bulk-migrate-${Math.floor(Date.now() / 1000)}`
      const { serverId, ip, dropletId } = await createDroplet({ name: newName })
      logPipeline(anchorDomain, "bulk_migrate", "running",
        `Droplet ${dropletId} up at ${ip} — installing SA agent (5–15 min)…`)
      const saId = await installAgentOnDroplet({
        dropletIp: ip, serverName: newName,
        onProgress: (msg) => logPipeline(anchorDomain, "bulk_migrate", "running", msg),
      })
      updateServer(serverId, { sa_server_id: saId, status: "ready" })
      return { ok: true, target: { id: serverId, ip, sa_server_id: saId } }
    } catch (e) {
      return { ok: false, reason: `provisioning failed: ${(e as Error).message}` }
    }
  }

  // Mode 3: round-robin to any eligible existing server. Excludes the
  // current server of the FIRST selected domain (heuristic — avoids the
  // common case of accidentally bulk-migrating-to-self).
  const firstDomain = listDomains().find((d) => d.domain === anchorDomain)
  const excludeId = firstDomain?.server_id ?? null
  const eligible = listServers().filter(
    (s) => s.status === "ready" && s.sa_server_id && s.ip &&
      (s.sites_count ?? 0) < (s.max_sites ?? 60) && s.id !== excludeId,
  )
  if (eligible.length === 0) {
    return { ok: false, reason: "no eligible 'ready' server with capacity (excluding source server)" }
  }
  // Cheap pick: lowest-utilization first (sites_count) so bulk migrations
  // spread instead of piling on the first server in the list.
  eligible.sort((a, b) => (a.sites_count ?? 0) - (b.sites_count ?? 0))
  const s = eligible[0]
  return { ok: true, target: { id: s.id, ip: s.ip!, sa_server_id: s.sa_server_id! } }
}

export async function bulkMigrateHandler(
  payload: Record<string, unknown>,
): Promise<void> {
  const p = payload as unknown as BulkMigratePayload
  const domains = (p.domains ?? []).filter((d) => typeof d === "string" && d.length > 0)
  if (domains.length === 0) {
    logPipeline("(bulk-migrate)", "bulk_migrate", "warning",
      "Empty domain list — nothing to do")
    return
  }
  const anchor = domains[0]

  // Heartbeat across ALL selected domains for the lifetime of the job.
  const { startHeartbeat } = await import("../repos/steps")
  const ticker = startHeartbeat(domains, 1000)

  try {
    const r = await resolveTarget(p, anchor)
    if (!r.ok) {
      logPipeline(anchor, "bulk_migrate", "failed",
        `Target resolution failed: ${r.reason}`)
      return
    }
    const target = r.target
    logPipeline(anchor, "bulk_migrate", "running",
      `Target server #${target.id} (${target.ip}) selected — migrating ${domains.length} domain(s)`)

    const ok: string[] = []
    const failed: { domain: string; msg: string }[] = []
    for (const d of domains) {
      try {
        const result = await migrateDomain(d, target)
        if (result.ok) ok.push(d)
        else failed.push({ domain: d, msg: result.message })
      } catch (e) {
        failed.push({ domain: d, msg: `unhandled: ${(e as Error).message}` })
      }
    }
    logPipeline(anchor, "bulk_migrate", failed.length === 0 ? "completed" : "warning",
      `Migrated ${ok.length}/${domains.length} domain(s) to server #${target.id} (${target.ip})` +
      (failed.length > 0 ? ` · failures: ${failed.map((f) => `${f.domain} (${f.msg.slice(0, 80)})`).join("; ")}` : ""))
  } finally {
    ticker.stop()
  }
}
