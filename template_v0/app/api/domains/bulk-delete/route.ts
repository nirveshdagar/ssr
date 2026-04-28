import { NextResponse, type NextRequest } from "next/server"
import { listDomains, deleteDomain } from "@/lib/repos/domains"
import { releaseCfKeySlot } from "@/lib/cf-key-pool"
import { enqueueJob } from "@/lib/jobs"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Bulk delete by domain ID list. `delete_from`:
 *   - "db_only"       → soft delete (release slot + drop row, in-process)
 *   - "all"           → enqueue ONE domain.bulk_teardown that walks the list
 *                       sequentially in a single worker. Smallest external-API
 *                       blast radius. ~10–15 s per domain.
 *   - "all_parallel"  → enqueue ONE domain.teardown PER domain so the worker
 *                       pool fans them out (up to SSR_JOB_WORKERS). Each
 *                       teardown still goes through the per-CF-key semaphore
 *                       and Spaceship's 5 s self-throttle, so per-key burst
 *                       remains bounded; total wall-time drops by ~Nx.
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
  if (deleteFrom === "all_parallel") {
    const jobIds = domains.map((d) => enqueueJob("domain.teardown", { domain: d }))
    appendAudit("domain_bulk_delete", "",
      `full teardown PARALLEL count=${domains.length} jobs=[${jobIds.slice(0, 5).join(",")}` +
      `${jobIds.length > 5 ? ",…" : ""}]`, ip)
    return NextResponse.json({
      ok: true, count: domains.length, job_ids: jobIds, mode: "full_parallel",
      message:
        `Full deletion started for ${domains.length} domain(s) — ` +
        `running up to N at a time (N = SSR_JOB_WORKERS, default 4). ` +
        `Per-key CF semaphore + Spaceship throttle still apply.`,
    })
  }
  const jobId = enqueueJob("domain.bulk_teardown", { domains })
  appendAudit("domain_bulk_delete", "", `full teardown count=${domains.length} job=${jobId}`, ip)
  return NextResponse.json({
    ok: true, count: domains.length, job_id: jobId, mode: "full",
    message:
      `Full deletion started for ${domains.length} domain(s) — ` +
      `running ONE AT A TIME in a single worker (~10–15 s per domain).`,
  })
}
