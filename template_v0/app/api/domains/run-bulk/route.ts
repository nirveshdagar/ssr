import { NextResponse, type NextRequest } from "next/server"
import { runBulkPipeline } from "@/lib/pipeline"
import { listDomains } from "@/lib/repos/domains"

export const runtime = "nodejs"

/** Bulk pipeline by domain ID list. */
export async function POST(req: NextRequest): Promise<Response> {
  const form = await req.formData().catch(() => null)
  const domainIds = (form?.getAll("domain_ids") ?? []).map((v) => String(v))
  const skipPurchase = ((form?.get("skip_purchase") as string | null) || "") === "on"
  const serverIdRaw = ((form?.get("server_id") as string | null) || "").trim()
  const serverId = serverIdRaw ? Number.parseInt(serverIdRaw, 10) : null
  const forceNewServer = ((form?.get("force_new_server") as string | null) || "") === "on"
  const idSet = new Set(domainIds)
  const domainsList = listDomains()
    .filter((d) => idSet.has(String(d.id)))
    .map((d) => d.domain)
  if (!domainsList.length) {
    return NextResponse.json({ ok: false, error: "No matching domains" }, { status: 400 })
  }
  const result = runBulkPipeline(domainsList, { skipPurchase, serverId, forceNewServer })
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
