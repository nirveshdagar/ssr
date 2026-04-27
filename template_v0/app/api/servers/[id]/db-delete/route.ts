import { NextResponse, type NextRequest } from "next/server"
import { all, run } from "@/lib/db"
import { appendAudit } from "@/lib/repos/audit"
import { logPipeline } from "@/lib/repos/logs"

export const runtime = "nodejs"

interface ServerRow { id: number; name: string | null; ip: string | null }

/**
 * Soft delete: drop the dashboard row only. Does NOT touch the DO droplet
 * or the SA server record. Refuses if any domain still references this server.
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

  const ref = (all<{ n: number }>(
    "SELECT COUNT(*) AS n FROM domains WHERE server_id = ?", serverId,
  )[0]?.n) ?? 0
  if (ref > 0) {
    return NextResponse.json({
      ok: false,
      error: `Cannot remove — ${ref} domain(s) still reference this server. ` +
             "Soft-delete or move those domains first.",
    }, { status: 409 })
  }
  run("DELETE FROM servers WHERE id = ?", serverId)
  appendAudit("server_db_delete", String(serverId), `name=${row.name ?? ""} ip=${row.ip ?? ""}`, ip)
  logPipeline(row.name ?? `srv-${serverId}`, "server_db_delete", "completed",
    `Soft-deleted server #${serverId} (DO droplet untouched)`)
  return NextResponse.json({
    ok: true,
    message: `Server '${row.name ?? `#${serverId}`}' removed from dashboard. DO droplet + SA record still exist.`,
  })
}
