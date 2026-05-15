import { NextResponse, type NextRequest } from "next/server"
import { getServer, updateServer } from "@/lib/repos/servers"
import { appendAudit } from "@/lib/repos/audit"
import { logPipeline } from "@/lib/repos/logs"

export const runtime = "nodejs"

/**
 * Force-mark a server dead. Does NOT trigger migration — operator must hit
 * /migrate-now separately so an accidental click can't move 60 sites.
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
  const s = getServer(serverId)
  if (!s) return NextResponse.json({ ok: false, error: "Server not found" }, { status: 404 })
  updateServer(serverId, { status: "dead" })
  appendAudit("server_mark_dead", String(serverId), s.name ?? "", ip)
  logPipeline(`server-${serverId}`, "mark_dead", "warning", "Manually marked dead by user")
  return NextResponse.json({
    ok: true,
    message: `Server '${s.name ?? `#${serverId}`}' marked DEAD. Use Migrate Now to move its domains.`,
  })
}
