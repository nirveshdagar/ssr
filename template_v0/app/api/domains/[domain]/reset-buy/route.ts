import { NextResponse, type NextRequest } from "next/server"
import { runFullPipeline } from "@/lib/pipeline"
import { getDomain, updateDomain } from "@/lib/repos/domains"
import { resetSingleStep } from "@/lib/repos/steps"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

const SAFE_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

// Statuses where the domain is already acquired / the pipeline has moved
// past the buy — resetting these back to pending and re-running Step 1
// would be wrong (and pointless: Step 1's idempotency precheck would just
// skip the POST). Use "Run from step N" for those instead.
const ALREADY_ACQUIRED = new Set([
  "purchased", "owned", "cf_assigned", "zone_created", "ns_set",
  "ns_pending_external", "zone_active", "app_created", "ready_for_ssl",
  "ssl_installed", "ready_for_content", "hosted", "live",
])

/**
 * "Reset Step 1 (allow re-buy)" — clears the Step 1 entry guard so a
 * failed/never-bought domain re-runs the purchase WITHOUT delete+re-add.
 * The guard at pipeline.ts skips Step 1 for any non-pending status, and the
 * normal Force/Run-from resets only touch step_tracker, not domains.status.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
): Promise<Response> {
  const { domain } = await params
  if (!SAFE_DOMAIN.test(domain)) {
    return NextResponse.json({ ok: false, error: "invalid domain shape" }, { status: 400 })
  }
  const d = getDomain(domain)
  if (!d) {
    return NextResponse.json(
      { ok: false, error: `Unknown domain '${domain}' — add it first` },
      { status: 404 },
    )
  }
  const status = d.status ?? "pending"
  if (ALREADY_ACQUIRED.has(status)) {
    return NextResponse.json({
      ok: false,
      message:
        `'${domain}' is '${status}' — it looks already purchased / in progress, ` +
        `so reset-buy is blocked (it's only for failed or never-bought domains). ` +
        `Use "Run from step N" if you meant to re-run a later step.`,
    }, { status: 409 })
  }

  // Clear the Step 1 guard + unlock step 1's tracker, then kick the
  // pipeline from step 1. Later steps keep their tracker state, so
  // smart-resume still skips anything already completed (e.g. a CF zone
  // created by an earlier skipped run).
  updateDomain(domain, { status: "pending" } as Parameters<typeof updateDomain>[1])
  resetSingleStep(domain, 1)
  const jobId = runFullPipeline(domain, { startFrom: 1 })

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  appendAudit("pipeline_reset_buy", domain, `from_status=${status} job=${jobId ?? "skipped"}`, ip)

  if (jobId == null) {
    return NextResponse.json({
      ok: false,
      message: `Pipeline for ${domain} already running — reset ignored`,
    })
  }
  return NextResponse.json({
    ok: true,
    job_id: jobId,
    message: `${domain} reset (was '${status}') — Step 1 will re-run the purchase`,
  })
}
