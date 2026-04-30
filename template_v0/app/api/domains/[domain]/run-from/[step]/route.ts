import { NextResponse, type NextRequest } from "next/server"
import { runFullPipeline } from "@/lib/pipeline"
import { getDomain } from "@/lib/repos/domains"
import { resetStepsFrom } from "@/lib/repos/steps"
import { appendAudit } from "@/lib/repos/audit"

const SAFE_MODEL = /^[A-Za-z0-9._/@:-]{1,128}$/
const SAFE_PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/
const SAFE_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

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
  if (!SAFE_DOMAIN.test(domain)) {
    return NextResponse.json({ ok: false, error: "invalid domain shape" }, { status: 400 })
  }
  if (!getDomain(domain)) {
    return NextResponse.json(
      { ok: false, error: `Unknown domain '${domain}' — add it first` },
      { status: 404 },
    )
  }
  // Body can be FormData OR JSON — older callers send form-data, the new
  // Force / Regenerate-with-prompt UI sends JSON to carry custom_prompt /
  // custom_provider / custom_model.
  const ct = req.headers.get("content-type") ?? ""
  let skipPurchase = false
  let customPrompt: string | null = null
  let customProvider: string | null = null
  let customModel: string | null = null
  const trimOrNull = (v: unknown): string | null => {
    if (typeof v !== "string") return null
    const t = v.trim()
    return t || null
  }
  if (ct.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    skipPurchase = body.skip_purchase === true || body.skip_purchase === "on"
    customPrompt = trimOrNull(body.custom_prompt)
    customProvider = trimOrNull(body.custom_provider)
    customModel = trimOrNull(body.custom_model)
  } else {
    const form = await req.formData().catch(() => null)
    skipPurchase = ((form?.get("skip_purchase") as string | null) || "") === "on"
    customPrompt = trimOrNull(form?.get("custom_prompt"))
    customProvider = trimOrNull(form?.get("custom_provider"))
    customModel = trimOrNull(form?.get("custom_model"))
  }
  // Operator explicitly wants to re-run from step N → clear the lock for
  // step N AND every step after, so the per-step idempotency wrapper
  // actually executes the work. Earlier steps stay locked (preserved
  // 'completed' state) so we don't redo step 1's domain-buy or step 6's
  // 5-15 min server provisioning when the operator just wants to retry
  // step 9's LLM call.
  if (customProvider && !SAFE_PROVIDER.test(customProvider)) {
    return NextResponse.json({ ok: false, error: "invalid custom_provider" }, { status: 400 })
  }
  if (customModel && !SAFE_MODEL.test(customModel)) {
    return NextResponse.json({ ok: false, error: "invalid custom_model" }, { status: 400 })
  }
  resetStepsFrom(domain, stepNum)
  const jobId = runFullPipeline(domain, {
    skipPurchase, startFrom: stepNum,
    customPrompt, customProvider, customModel,
  })
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  appendAudit(
    "pipeline_run_from", domain,
    `job=${jobId ?? "skipped"} step=${stepNum} skip_purchase=${skipPurchase} ` +
    `provider=${customProvider ?? ""} model=${customModel ?? ""}`,
    ip,
  )
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
