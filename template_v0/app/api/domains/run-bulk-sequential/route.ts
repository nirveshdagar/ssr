import { NextResponse, type NextRequest } from "next/server"
import { runSequentialBulkPipeline } from "@/lib/pipeline"
import { listDomains } from "@/lib/repos/domains"

export const runtime = "nodejs"

const MAX_BULK = 1000

/**
 * Sequential bulk run — same input shape as /api/domains/run-bulk but
 * enqueues a SINGLE pipeline.bulk job that walks the selected domains
 * one-by-one in a single worker (vs. run-bulk's per-domain fan-out).
 * Use when you want to keep external-API blast radius minimal.
 */
export async function POST(req: NextRequest): Promise<Response> {
  // Accept both FormData (legacy) and JSON. Same field shape either way.
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
  const idSet = new Set(domainIds)
  const domainsList = listDomains()
    .filter((d) => idSet.has(String(d.id)))
    .map((d) => d.domain)
  if (!domainsList.length) {
    return NextResponse.json({ ok: false, error: "No matching domains" }, { status: 400 })
  }
  const result = runSequentialBulkPipeline(domainsList, {
    skipPurchase, serverId, forceNewServer, customProvider, customModel,
  })
  if (result.enqueued === 0) {
    return NextResponse.json({
      ok: false,
      skipped: result.skipped,
      message: "Every selected domain already has a pipeline running — sequential bulk skipped",
    })
  }
  const skipNote = result.skipped > 0
    ? ` · ${result.skipped} skipped (already running)`
    : ""
  return NextResponse.json({
    ok: true,
    job_id: result.job_id,
    job_ids: result.job_ids,
    count: result.enqueued,
    skipped: result.skipped,
    message:
      `Sequential pipeline enqueued — ${result.enqueued} domain(s)${skipNote}; ` +
      `running ONE AT A TIME in a single worker. Total wall-time = sum of per-domain durations.`,
  })
}
