import { NextResponse, type NextRequest } from "next/server"
import { runFullPipeline } from "@/lib/pipeline"
import { getDomain } from "@/lib/repos/domains"

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
