import { NextResponse, type NextRequest } from "next/server"
import { listServers as listDbServers, updateServer } from "@/lib/repos/servers"
import { listServers as listSaServers } from "@/lib/serveravatar"
import { getSetting } from "@/lib/repos/settings"
import { appendAudit } from "@/lib/repos/audit"
import { logPipeline } from "@/lib/repos/logs"

export const runtime = "nodejs"

interface ReconcileItem {
  id: number
  name: string | null
  ip: string | null
  prev_status: string
  sa_server_id: string
  sa_status: string
}

/**
 * Reconcile orphaned `servers` rows against ServerAvatar's fleet.
 *
 * The 5-15 min SA agent install can outlast the Node side of a pipeline
 * (SSH timeout, worker restart, etc.) — when that happens the droplet is
 * up + the SA agent connects, but the DB row is left without sa_server_id
 * and never reaches status='ready'. The pipeline's findServer() filter
 * then ignores it and the orphan gathers dust.
 *
 * This endpoint walks SA, matches each SA server to a DB row by IP, and
 * back-fills sa_server_id / sa_org_id / status='ready' on candidates that
 * SA reports as connected. Idempotent — already-ready rows are skipped.
 *
 * Form params:
 *   dry_run=on   — preview only, no DB writes (returns the same shape)
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const dryRun = ((form?.get("dry_run") as string | null) || "") === "on"

  let saServers
  try {
    saServers = await listSaServers()
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `SA list-servers failed: ${(e as Error).message}` },
      { status: 502 },
    )
  }

  // Index SA fleet by normalized IP for O(1) lookup
  const saByIp = new Map<string, typeof saServers[number]>()
  for (const s of saServers) {
    const sIp = String(s.server_ip ?? s.ip ?? "").trim()
    if (sIp) saByIp.set(sIp, s)
  }

  const orgId = (getSetting("serveravatar_org_id") || "").trim()

  const claimed: ReconcileItem[] = []
  const stillOrphaned: { id: number; name: string | null; ip: string | null; reason: string }[] = []
  let alreadyOk = 0

  for (const row of listDbServers()) {
    if (row.sa_server_id && row.status === "ready") {
      alreadyOk++
      continue
    }
    const dbIp = (row.ip ?? "").trim()
    if (!dbIp) {
      stillOrphaned.push({ id: row.id, name: row.name, ip: row.ip, reason: "no IP on DB row" })
      continue
    }
    const match = saByIp.get(dbIp)
    if (!match) {
      stillOrphaned.push({
        id: row.id, name: row.name, ip: row.ip,
        reason: `no SA server with ip=${dbIp}`,
      })
      continue
    }
    const saStatus = String(match.agent_status ?? match.status ?? "")
    const isConnected = saStatus === "connected" || saStatus === "active" || saStatus === "1"
    if (!isConnected) {
      stillOrphaned.push({
        id: row.id, name: row.name, ip: row.ip,
        reason: `SA agent_status='${saStatus}' (waiting for connect)`,
      })
      continue
    }

    const saId = String(match.id ?? "")
    if (!saId) {
      stillOrphaned.push({
        id: row.id, name: row.name, ip: row.ip,
        reason: "SA server has no id field",
      })
      continue
    }

    if (!dryRun) {
      updateServer(row.id, {
        sa_server_id: saId,
        sa_org_id: orgId || row.sa_org_id || null,
        status: "ready",
      } as Parameters<typeof updateServer>[1])
      logPipeline(`server-${row.id}`, "reconcile_sa", "completed",
        `Claimed orphan: linked sa_server_id=${saId} (was status='${row.status}')`)
    }

    claimed.push({
      id: row.id, name: row.name, ip: row.ip,
      prev_status: row.status,
      sa_server_id: saId,
      sa_status: saStatus,
    })
  }

  if (!dryRun && claimed.length > 0) {
    appendAudit(
      "servers_reconcile_from_sa", "",
      `claimed=${claimed.length} orphaned=${stillOrphaned.length} already_ok=${alreadyOk}`,
      ip,
    )
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    claimed,
    still_orphaned: stillOrphaned,
    already_ok: alreadyOk,
    message: dryRun
      ? `Preview: would claim ${claimed.length} orphan(s); ${stillOrphaned.length} still unmatched; ${alreadyOk} already linked.`
      : `Claimed ${claimed.length} orphan(s); ${stillOrphaned.length} still unmatched; ${alreadyOk} already linked.`,
  })
}
