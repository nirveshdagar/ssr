import { NextResponse, type NextRequest } from "next/server"
import { autoHealTickOnce } from "@/lib/auto-heal"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Manually fire one auto-heal sweep tick. Same logic the background loop
 * runs every SSR_AUTOHEAL_INTERVAL_MS. Useful when an operator just landed
 * a bunch of fixes and wants the recovery to happen NOW instead of waiting
 * for the next scheduled tick.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const result = await autoHealTickOnce()

  const claimed = "claimed" in result.reconcile ? result.reconcile.claimed.length : 0
  const resumed = "resumed" in result.resume ? result.resume.resumed.length : 0
  const nsResumed = "resumed" in result.ns ? result.ns.resumed.length : 0
  const retried = "retried" in result.retry ? result.retry.retried.length : 0
  appendAudit(
    "auto_heal_manual", "",
    `claimed=${claimed} resumed=${resumed} ns_resumed=${nsResumed} retried=${retried}`,
    ip,
  )

  return NextResponse.json({
    ok: true,
    ...result,
    message:
      `Auto-heal tick: claimed ${claimed} server(s), resumed ${resumed} pipeline(s), ` +
      `${nsResumed} NS-pending domain(s) advanced, ${retried} retryable_error domain(s) re-enqueued.`,
  })
}
