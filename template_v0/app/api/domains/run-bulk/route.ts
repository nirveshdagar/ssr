import { NextResponse, type NextRequest } from "next/server"
import { runBulkPipeline } from "@/lib/pipeline"
import { listDomains } from "@/lib/repos/domains"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

const MAX_BULK = 1000
const SAFE_MODEL = /^[A-Za-z0-9._/@:-]{1,128}$/
const SAFE_PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/

/**
 * Bulk pipeline by domain ID list. Accepts BOTH FormData (legacy /domains
 * page client) AND JSON (any new client wanting to send custom_provider /
 * custom_model). Same field shape either way.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ct = req.headers.get("content-type") ?? ""
  let domainIds: string[] = []
  let skipPurchase = false
  let serverId: number | null = null
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
    domainIds = Array.isArray(body.domain_ids) ? (body.domain_ids as unknown[]).map(String) : []
    skipPurchase = body.skip_purchase === true || body.skip_purchase === "on"
    forceNewServer = body.force_new_server === true || body.force_new_server === "on"
    const sid = trimOrNull(body.server_id)
    serverId = sid ? Number.parseInt(sid, 10) : null
    customProvider = trimOrNull(body.custom_provider)
    customModel = trimOrNull(body.custom_model)
  } else {
    const form = await req.formData().catch(() => null)
    domainIds = (form?.getAll("domain_ids") ?? []).map((v) => String(v))
    skipPurchase = ((form?.get("skip_purchase") as string | null) || "") === "on"
    forceNewServer = ((form?.get("force_new_server") as string | null) || "") === "on"
    const sid = trimOrNull(form?.get("server_id"))
    serverId = sid ? Number.parseInt(sid, 10) : null
    customProvider = trimOrNull(form?.get("custom_provider"))
    customModel = trimOrNull(form?.get("custom_model"))
  }
  if (domainIds.length > MAX_BULK) {
    return NextResponse.json(
      { ok: false, error: `too many domains (${domainIds.length} > ${MAX_BULK})` },
      { status: 413 },
    )
  }
  if (customProvider && !SAFE_PROVIDER.test(customProvider)) {
    return NextResponse.json({ ok: false, error: "invalid custom_provider" }, { status: 400 })
  }
  if (customModel && !SAFE_MODEL.test(customModel)) {
    return NextResponse.json({ ok: false, error: "invalid custom_model" }, { status: 400 })
  }
  const idSet = new Set(domainIds)
  const domainsList = listDomains()
    .filter((d) => idSet.has(String(d.id)))
    .map((d) => d.domain)
  if (!domainsList.length) {
    return NextResponse.json({ ok: false, error: "No matching domains" }, { status: 400 })
  }
  const result = runBulkPipeline(domainsList, {
    skipPurchase, serverId, forceNewServer, customProvider, customModel,
  })
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  appendAudit(
    "pipeline_run_bulk", "",
    `count=${domainsList.length} enqueued=${result.enqueued} skipped=${result.skipped} ` +
    `server_id=${serverId ?? ""} force_new_server=${forceNewServer} ` +
    `provider=${customProvider ?? ""} model=${customModel ?? ""}`,
    ip,
  )
  if (result.enqueued === 0) {
    return NextResponse.json({
      ok: false,
      skipped: result.skipped,
      message: "Every selected domain already has a pipeline running — bulk skipped",
    })
  }
  // One pipeline.full job per domain → the 4-worker pool fans them out
  // (up to SSR_JOB_WORKERS in parallel). Operator gets a one-line summary.
  const skipNote = result.skipped > 0
    ? ` · ${result.skipped} skipped (already running)`
    : ""
  return NextResponse.json({
    ok: true,
    job_id: result.job_id,        // back-compat alias for the first job
    job_ids: result.job_ids,      // full list — caller can poll any
    count: result.enqueued,
    skipped: result.skipped,
    message: `Bulk pipeline enqueued — ${result.enqueued} domain(s)${skipNote}; running up to N in parallel (N = SSR_JOB_WORKERS, default 4)`,
  })
}
