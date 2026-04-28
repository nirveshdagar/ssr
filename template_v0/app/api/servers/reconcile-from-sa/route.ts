import { NextResponse, type NextRequest } from "next/server"
import { reconcileOrphanServers } from "@/lib/auto-heal"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

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

  let result
  try {
    result = await reconcileOrphanServers({ dryRun })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `SA list-servers failed: ${(e as Error).message}` },
      { status: 502 },
    )
  }

  if (!dryRun && result.claimed.length > 0) {
    appendAudit(
      "servers_reconcile_from_sa", "",
      `claimed=${result.claimed.length} orphaned=${result.stillOrphaned.length} already_ok=${result.alreadyOk}`,
      ip,
    )
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    claimed: result.claimed,
    still_orphaned: result.stillOrphaned,
    already_ok: result.alreadyOk,
    message: dryRun
      ? `Preview: would claim ${result.claimed.length} orphan(s); ${result.stillOrphaned.length} still unmatched; ${result.alreadyOk} already linked.`
      : `Claimed ${result.claimed.length} orphan(s); ${result.stillOrphaned.length} still unmatched; ${result.alreadyOk} already linked.`,
  })
}
