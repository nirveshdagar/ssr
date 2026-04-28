import { NextResponse, type NextRequest } from "next/server"
import { all, run } from "@/lib/db"
import { listDomains, deleteDomain } from "@/lib/repos/domains"
import { releaseCfKeySlot } from "@/lib/repos/domains"
import { appendAudit } from "@/lib/repos/audit"
import { logPipeline } from "@/lib/repos/logs"

export const runtime = "nodejs"

interface ServerRow { id: number; name: string | null; ip: string | null }

/**
 * Soft delete: drop the dashboard row + CASCADE-DROP every domain row
 * pointing at this server. Does NOT touch the DO droplet, the SA server
 * record, or the SA applications hosted on it — those stay live, the
 * SSR dashboard just stops tracking them.
 *
 * Operator can later "Add existing server" with the same name + IP +
 * sa_server_id, and the dashboard will auto-detect every app on that
 * server and re-link the domain rows in one shot.
 *
 * Per-domain cleanup mirrors the soft-delete-domain path:
 *   - Release the CF pool slot (cf_keys.domains_used--)
 *   - DELETE the domain row from `domains`
 *
 * The on-disk archive at data/site_archives/<domain>.tar.gz is NOT
 * removed here (operator may want it for a later migration to a
 * different server). For full disposal use Domains → Full delete.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const serverId = Number.parseInt(id, 10)
  if (!Number.isFinite(serverId)) {
    return NextResponse.json({ ok: false, error: "invalid server id" }, { status: 400 })
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const row = all<ServerRow>("SELECT id, name, ip FROM servers WHERE id = ?", serverId)[0]
  if (!row) return NextResponse.json({ ok: false, error: "Server not found" }, { status: 404 })

  // Cascade-drop the domain rows — release CF pool slots first, then DELETE.
  const domains = listDomains().filter((d) => d.server_id === serverId)
  const droppedDomains: string[] = []
  for (const d of domains) {
    try { releaseCfKeySlot(d.domain) } catch { /* slot release best-effort */ }
    try {
      deleteDomain(d.domain)
      droppedDomains.push(d.domain)
    } catch { /* one bad row shouldn't block the rest */ }
  }

  run("DELETE FROM servers WHERE id = ?", serverId)
  appendAudit(
    "server_db_delete", String(serverId),
    `name=${row.name ?? ""} ip=${row.ip ?? ""} cascaded_domains=${droppedDomains.length}`,
    ip,
  )
  logPipeline(row.name ?? `srv-${serverId}`, "server_db_delete", "completed",
    `Soft-deleted server #${serverId} + cascaded ${droppedDomains.length} domain row(s) ` +
    `(DO droplet + SA server + SA apps still live)`)

  return NextResponse.json({
    ok: true,
    cascaded_domains: droppedDomains,
    message: `Server '${row.name ?? `#${serverId}`}' removed from dashboard along with ` +
      `${droppedDomains.length} domain row(s). DO droplet + SA records still exist; ` +
      `re-add via "Add existing server" to repopulate the domain list automatically.`,
  })
}
