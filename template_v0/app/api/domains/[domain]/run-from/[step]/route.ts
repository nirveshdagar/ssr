import { NextResponse, type NextRequest } from "next/server"
import { runFullPipeline } from "@/lib/pipeline"
import { getDomain } from "@/lib/repos/domains"
import { resetStepsFrom } from "@/lib/repos/steps"

export const runtime = "nodejs"

/**
 * Resume from step N. "Skip this step" is just /run-from/(N+1) — the same
 * endpoint with the next number.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ domain: string; step: string }> },
): Promise<Response> {
  const { domain, step } = await params
  const stepNum = Number.parseInt(step, 10)
  if (!Number.isFinite(stepNum) || stepNum < 1 || stepNum > 10) {
    return NextResponse.json({ ok: false, error: "step must be between 1 and 10" }, { status: 400 })
  }
  if (!getDomain(domain)) {
    return NextResponse.json(
      { ok: false, error: `Unknown domain '${domain}' — add it first` },
      { status: 404 },
    )
  }
  const form = await req.formData().catch(() => null)
  const skipPurchase = ((form?.get("skip_purchase") as string | null) || "") === "on"
  // Operator explicitly wants to re-run from step N → clear the lock for
  // step N AND every step after, so the per-step idempotency wrapper
  // actually executes the work. Earlier steps stay locked (preserved
  // 'completed' state) so we don't redo step 1's domain-buy or step 6's
  // 5-15 min server provisioning when the operator just wants to retry
  // step 9's LLM call.
  resetStepsFrom(domain, stepNum)
  const jobId = runFullPipeline(domain, { skipPurchase, startFrom: stepNum })
  if (jobId == null) {
    return NextResponse.json({
      ok: false,
      message: `Pipeline for ${domain} already running — request ignored`,
    })
  }
  return NextResponse.json({
    ok: true, job_id: jobId,
    message: `Pipeline started for ${domain} from step ${stepNum}`,
  })
}
