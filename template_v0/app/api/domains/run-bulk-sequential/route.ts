import { NextResponse, type NextRequest } from "next/server"
import { runSequentialBulkPipeline } from "@/lib/pipeline"
import { listDomains } from "@/lib/repos/domains"

export const runtime = "nodejs"

/**
 * Sequential bulk run — same input shape as /api/domains/run-bulk but
 * enqueues a SINGLE pipeline.bulk job that walks the selected domains
 * one-by-one in a single worker (vs. run-bulk's per-domain fan-out).
 * Use when you want to keep external-API blast radius minimal.
 */
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
  const result = runSequentialBulkPipeline(domainsList, { skipPurchase, serverId, forceNewServer })
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
