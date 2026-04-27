import { NextResponse, type NextRequest } from "next/server"
import { listDomains, deleteDomain } from "@/lib/repos/domains"
import { releaseCfKeySlot } from "@/lib/cf-key-pool"
import { enqueueJob } from "@/lib/jobs"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Bulk delete by domain ID list. `delete_from`:
 *   - "db_only" → soft delete (release slot + drop row, in-process)
 *   - anything else → enqueue domain.bulk_teardown for full teardown
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const domainIds = form?.getAll("domain_ids").map((v) => String(v)) ?? []
  const deleteFrom = ((form?.get("delete_from") as string | null) || "all").trim()
  if (!domainIds.length) {
    return NextResponse.json({ ok: false, error: "No domains selected" }, { status: 400 })
  }
  const idSet = new Set(domainIds)
  const domains = listDomains().filter((d) => idSet.has(String(d.id))).map((d) => d.domain)
  if (!domains.length) {
    return NextResponse.json({ ok: false, error: "No matching domains" }, { status: 400 })
  }
  if (deleteFrom === "db_only") {
    for (const d of domains) {
      releaseCfKeySlot(d)
      deleteDomain(d)
    }
    appendAudit("domain_bulk_delete", "", `db_only count=${domains.length}`, ip)
    return NextResponse.json({
      ok: true, count: domains.length, mode: "db_only",
      message: `Deleted ${domains.length} domain(s) from dashboard`,
    })
  }
  const jobId = enqueueJob("domain.bulk_teardown", { domains })
  appendAudit("domain_bulk_delete", "", `full teardown count=${domains.length} job=${jobId}`, ip)
  return NextResponse.json({
    ok: true, count: domains.length, job_id: jobId, mode: "full",
    message: `Full deletion started for ${domains.length} domain(s)`,
  })
}
