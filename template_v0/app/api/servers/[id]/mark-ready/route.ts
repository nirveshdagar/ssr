import { NextResponse, type NextRequest } from "next/server"
import { getServer, updateServer } from "@/lib/repos/servers"
import { listDomains } from "@/lib/repos/domains"
import { releaseServerMigrating, clearDownStreaksForServerDomains } from "@/lib/live-checker"
import { appendAudit } from "@/lib/repos/audit"
import { logPipeline } from "@/lib/repos/logs"

export const runtime = "nodejs"

/** Clear a dead-marking false positive. Resets live-checker down-streaks
 *  for every domain on this server so a flake can't re-flip on the next tick. */
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
  const prev = s.status
  updateServer(serverId, { status: "ready" })
  releaseServerMigrating(serverId)
  const domainsOnServer = listDomains().filter((d) => d.server_id === serverId).map((d) => d.domain)
  clearDownStreaksForServerDomains(domainsOnServer)
  appendAudit("server_mark_ready", String(serverId), `prev=${prev}`, ip)
  logPipeline(`server-${serverId}`, "mark_ready", "completed",
    `Manually restored to 'ready' (was '${prev}')`)
  return NextResponse.json({
    ok: true,
    message: `Server '${s.name ?? `#${serverId}`}' restored to 'ready'. Down-streaks reset.`,
  })
}
