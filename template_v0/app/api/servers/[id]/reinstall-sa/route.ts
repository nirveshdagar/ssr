import { NextResponse, type NextRequest } from "next/server"
import { enqueueJob } from "@/lib/jobs"
import { getServer } from "@/lib/repos/servers"
import { appendAudit } from "@/lib/repos/audit"
import { clientIp } from "@/lib/request-ip"

export const runtime = "nodejs"

/**
 * POST /api/servers/[id]/reinstall-sa
 *
 * Re-runs the ServerAvatar agent install on this server's existing DO
 * droplet. Used when the original install failed mid-script (the droplet
 * is fine, just needs a clean re-run). The job:
 *
 *   1. Deletes any stale SA-side entries for this server (by id or IP)
 *   2. Re-runs the SA install command via SSH
 *   3. Polls SA for the agent to register, with the same retry-with-cleanup
 *      as a fresh provision (2 attempts × 15 min each, default)
 *   4. On success: server status goes from 'creating'/'error' → 'ready'
 *      with the new sa_server_id
 *   5. On failure after all retries: server status goes to 'error', logged
 *      + audited
 *
 * Returns the enqueued job id. Poll /api/runs/[id] for progress.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const serverId = Number.parseInt(id, 10)
  if (!Number.isFinite(serverId) || serverId <= 0) {
    return NextResponse.json({ ok: false, error: "invalid server id" }, { status: 400 })
  }
  const server = getServer(serverId)
  if (!server) {
    return NextResponse.json({ ok: false, error: `server #${id} not found` }, { status: 404 })
  }
  if (!server.ip || !server.do_droplet_id) {
    return NextResponse.json(
      { ok: false, error: "server has no IP / droplet id — provision a new server instead" },
      { status: 400 },
    )
  }
  const ip = clientIp(req)
  const jobId = enqueueJob("server.reinstall_sa", { server_id: serverId }, 1)
  appendAudit("server_reinstall_sa_enqueue", `server-${serverId}`,
    `name=${server.name ?? ""} ip=${server.ip} job=${jobId}`, ip)
  return NextResponse.json({
    ok: true,
    job_id: jobId,
    message:
      `SA reinstall enqueued for server #${serverId} (${server.name ?? ""} / ${server.ip}). ` +
      `Watch /logs for "reinstall_sa" entries — full reinstall takes 5-15 min × up to 2 attempts.`,
  })
}
