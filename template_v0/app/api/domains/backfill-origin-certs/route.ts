import { NextResponse, type NextRequest } from "next/server"
import { listDomains } from "@/lib/repos/domains"
import { enqueueJob } from "@/lib/jobs"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * One-shot: for every domain with a CF zone but no cached origin_cert_pem,
 * enqueue a job that re-issues + caches the Origin CA cert. Worker runs
 * sequentially in the background — may take minutes for large fleets.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const targets = listDomains()
    .filter((d) => d.cf_zone_id && !d.origin_cert_pem)
    .map((d) => d.domain)
  if (!targets.length) {
    return NextResponse.json({
      ok: true, count: 0,
      message: "All domains already have cached Origin certs — nothing to backfill.",
    })
  }
  const jobId = enqueueJob("cert.backfill", { domains: targets })
  appendAudit("backfill_origin_certs", "", `enqueued ${targets.length} domains job=${jobId}`, ip)
  return NextResponse.json({
    ok: true, count: targets.length, job_id: jobId,
    message: `Backfilling Origin certs for ${targets.length} domain(s) in background.`,
  })
}
