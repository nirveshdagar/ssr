import { NextResponse, type NextRequest } from "next/server"
import { all, run } from "@/lib/db"
import { listApplications } from "@/lib/serveravatar"
import { releaseCfKeySlot, deleteDomain } from "@/lib/repos/domains"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Reverse of import-from-sa: remove domain rows whose SA app no longer
 * exists upstream. Mirrors the Flask api_domains_sync_from_sa with
 * partial-failure-tolerant semantics (one server failing doesn't abort
 * the whole sync; domains on unqueryable servers are skipped, NOT
 * removed).
 */
const HOSTED_STATES = ["app_created", "ssl_installed", "hosted", "live"]

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null

  const servers = all<{ id: number; sa_server_id: string }>(
    "SELECT id, sa_server_id FROM servers WHERE sa_server_id IS NOT NULL AND status='ready'",
  )

  const livePairs = new Set<string>() // `${db_id}:${domain.toLowerCase()}`
  const queriedIds = new Set<number>()
  const failedServers: string[] = []
  for (const s of servers) {
    try {
      const apps = await listApplications(s.sa_server_id)
      queriedIds.add(s.id)
      for (const a of apps) {
        const name = (a.name || a.primary_domain || "").toString().toLowerCase().trim()
        if (name) livePairs.add(`${s.id}:${name}`)
      }
    } catch (e) {
      failedServers.push(`sa_id=${s.sa_server_id}: ${(e as Error).name}: ${(e as Error).message}`)
    }
  }

  const placeholders = HOSTED_STATES.map(() => "?").join(",")
  const rows = all<{ domain: string; server_id: number; status: string }>(
    `SELECT domain, server_id, status FROM domains
      WHERE status IN (${placeholders}) AND server_id IS NOT NULL`,
    ...HOSTED_STATES,
  )

  const removed: string[] = []
  const skippedUnqueryable: string[] = []
  for (const r of rows) {
    if (!queriedIds.has(r.server_id)) {
      skippedUnqueryable.push(r.domain)
      continue
    }
    const pair = `${r.server_id}:${r.domain.toLowerCase()}`
    if (livePairs.has(pair)) continue
    removed.push(r.domain)
  }
  for (const d of removed) {
    try { releaseCfKeySlot(d) } catch {}
    deleteDomain(d)
  }

  appendAudit(
    "domains_sync_from_sa",
    "",
    `removed=${removed.length} skipped_unqueryable=${skippedUnqueryable.length} failed_servers=${failedServers.length}`,
    ip,
  )
  return NextResponse.json({
    ok: true,
    removed,
    skipped_unqueryable: skippedUnqueryable,
    failed_servers: failedServers,
  })
}
