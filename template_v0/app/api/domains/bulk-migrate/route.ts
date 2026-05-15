import { NextResponse, type NextRequest } from "next/server"
import { enqueueJob } from "@/lib/jobs"
import { listDomains } from "@/lib/repos/domains"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

const MAX_BULK = 1000

/**
 * Bulk-migrate selected domains to a target server. Each domain goes through
 * the standard migrateDomain primitive — old SA app removed, new SA app
 * created on target, CF A-records patched to target IP, cert + content
 * re-deployed from local archive. Original CF zone, NS, registrar untouched.
 *
 * Form params:
 *   domain_ids[]            — DB ids OR domain names of rows to migrate
 *   target_server_id=N      — pin to specific server
 *   force_new_server=on     — provision fresh DO droplet first (5–15 min)
 *   (neither)               — round-robin to lowest-utilization eligible server
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const rawIds = (form?.getAll("domain_ids") ?? []).map((v) => String(v))
  const targetServerIdRaw = ((form?.get("target_server_id") as string | null) || "").trim()
  const targetServerId = targetServerIdRaw ? Number.parseInt(targetServerIdRaw, 10) : null
  const forceNewServer = ((form?.get("force_new_server") as string | null) || "") === "on"

  if (rawIds.length === 0) {
    return NextResponse.json({ ok: false, error: "no domain_ids provided" }, { status: 400 })
  }
  if (rawIds.length > MAX_BULK) {
    return NextResponse.json(
      { ok: false, error: `too many domains (${rawIds.length} > ${MAX_BULK})` },
      { status: 413 },
    )
  }

  // Accept either numeric DB ids OR raw domain names so callers from
  // either /domains list or scripted batch jobs work without translation.
  const idSet = new Set(rawIds)
  const matched = listDomains().filter(
    (d) => idSet.has(String(d.id)) || idSet.has(d.domain),
  )
  if (matched.length === 0) {
    return NextResponse.json({ ok: false, error: "no matching domains" }, { status: 400 })
  }

  const jobId = enqueueJob("domain.bulk_migrate", {
    domains: matched.map((d) => d.domain),
    target_server_id: targetServerId,
    force_new_server: forceNewServer,
  })

  appendAudit(
    "domains_bulk_migrate", "",
    `count=${matched.length} target=${targetServerId ?? (forceNewServer ? "NEW" : "auto")} job=${jobId}`,
    ip,
  )

  return NextResponse.json({
    ok: true,
    job_id: jobId,
    count: matched.length,
    message: `Bulk migrate enqueued — ${matched.length} domain(s) → ` +
      (forceNewServer
        ? "fresh DO droplet (provisioning takes 5–15 min before migrations begin)"
        : targetServerId
          ? `server #${targetServerId}`
          : "lowest-utilization eligible server"),
  })
}
