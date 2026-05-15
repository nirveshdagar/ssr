import { NextResponse, type NextRequest } from "next/server"
import { listDomains } from "@/lib/repos/domains"
import { tryMarkServerMigrating, releaseServerMigrating } from "@/lib/live-checker"
import { enqueueJob } from "@/lib/jobs"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Manually trigger migration of every domain off `server_id` to a new server.
 * Optional form `target_server_id` — if omitted, picks an eligible server or
 * provisions a fresh one.
 *
 * Refuses if auto-detection is already migrating this server (the
 * live-checker `migrating` set is the shared "in progress" registry).
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
  const form = await req.formData().catch(() => null)
  const targetRaw = ((form?.get("target_server_id") as string | null) || "").trim()
  const targetId = /^\d+$/.test(targetRaw) ? Number.parseInt(targetRaw, 10) : null

  if (!tryMarkServerMigrating(serverId)) {
    return NextResponse.json({
      ok: false,
      message: `Server #${serverId} is already being migrated (auto-detected). ` +
               `Watch progress in the Watcher tab.`,
    })
  }

  const count = listDomains().filter((d) => d.server_id === serverId).length
  if (count === 0) {
    releaseServerMigrating(serverId)
    return NextResponse.json({
      ok: true, count: 0,
      message: `Server #${serverId} has no domains — nothing to migrate`,
    })
  }

  const jobId = enqueueJob("server.migrate_now", {
    server_id: serverId,
    target_server_id: targetId,
  })
  appendAudit("migrate_server_manual", String(serverId),
    `domains=${count} target_server_id=${targetId ?? ""}`, ip)
  return NextResponse.json({
    ok: true, job_id: jobId, count,
    message: `Migration started — moving ${count} domain(s) off server #${serverId}.`,
  })
}
