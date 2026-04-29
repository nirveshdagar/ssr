import { NextResponse, type NextRequest } from "next/server"
import { runFullPipeline } from "@/lib/pipeline"
import { getDomain } from "@/lib/repos/domains"

export const runtime = "nodejs"

/**
 * Kick off a full pipeline run for `domain`. Accepts FormData OR JSON. Optional fields:
 *   skip_purchase=on        — skip step 1 purchase (BYO domain)
 *   server_id=N             — pin to a specific server (else round-robin)
 *   start_from=N            — resume from step N (1-10)
 *   force_new_server=on     — bypass round-robin and always provision a fresh droplet
 *   custom_provider=<name>  — per-run LLM provider override for step 9 (anthropic|openai|gemini|...)
 *   custom_model=<id>       — per-run model override for step 9
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
): Promise<Response> {
  const { domain } = await params
  if (!getDomain(domain)) {
    return NextResponse.json(
      { ok: false, error: `Unknown domain '${domain}' — add it first` },
      { status: 404 },
    )
  }
  const ct = req.headers.get("content-type") ?? ""
  let skipPurchase = false
  let serverId: number | null = null
  let startFrom: number | null = null
  let forceNewServer = false
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
    forceNewServer = body.force_new_server === true || body.force_new_server === "on"
    const sid = trimOrNull(body.server_id)
    serverId = sid ? Number.parseInt(sid, 10) : null
    const sf = trimOrNull(body.start_from)
    startFrom = sf ? Number.parseInt(sf, 10) : null
    customProvider = trimOrNull(body.custom_provider)
    customModel = trimOrNull(body.custom_model)
  } else {
    const form = await req.formData().catch(() => null)
    skipPurchase = ((form?.get("skip_purchase") as string | null) || "") === "on"
    forceNewServer = ((form?.get("force_new_server") as string | null) || "") === "on"
    const sid = trimOrNull(form?.get("server_id"))
    serverId = sid ? Number.parseInt(sid, 10) : null
    const sf = trimOrNull(form?.get("start_from"))
    startFrom = sf ? Number.parseInt(sf, 10) : null
    customProvider = trimOrNull(form?.get("custom_provider"))
    customModel = trimOrNull(form?.get("custom_model"))
  }
  const jobId = runFullPipeline(domain, {
    skipPurchase, serverId, startFrom, forceNewServer,
    customProvider, customModel,
  })
  if (jobId == null) {
    return NextResponse.json({
      ok: false,
      message: `Pipeline for ${domain} already running — request ignored`,
    })
  }
  return NextResponse.json({ ok: true, job_id: jobId, message: `Pipeline started for ${domain}` })
}
