import { NextResponse, type NextRequest } from "next/server"
import { all } from "@/lib/db"
import { enqueueJob } from "@/lib/jobs"
import { appendAudit } from "@/lib/repos/audit"
import { isIP } from "node:net"

export const runtime = "nodejs"

/**
 * Bulk A-record change for selected domains under one CF key.
 * Mirrors POST /api/cf-keys/<id>/bulk-set-ip on the Flask side.
 *   domains[] (form-data, repeat) — selected domain names
 *   new_ip
 *   proxied   — 'on' or absent
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const keyId = Number(id)
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const requested = (form?.getAll("domains") ?? []).map((v) => String(v))
  const newIp = ((form?.get("new_ip") as string | null) || "").trim()
  const proxied = (form?.get("proxied") as string | null) === "on"

  if (requested.length === 0) {
    return NextResponse.json({ error: "No domains selected" }, { status: 400 })
  }
  if (!isIP(newIp)) {
    return NextResponse.json({ error: `Invalid IP: ${JSON.stringify(newIp)}` }, { status: 400 })
  }

  // Forged-form guard: every requested domain must be assigned to THIS key.
  const placeholders = requested.map(() => "?").join(",")
  const verified = all<{ domain: string }>(
    `SELECT domain FROM domains WHERE cf_key_id = ? AND domain IN (${placeholders})`,
    keyId,
    ...requested,
  ).map((r) => r.domain)
  const verifiedSet = new Set(verified)
  const rejected = requested.filter((d) => !verifiedSet.has(d))
  if (rejected.length) {
    return NextResponse.json(
      {
        error: `Refused: ${rejected.length} domain(s) not assigned to CF key #${keyId}`,
        rejected: rejected.slice(0, 5),
      },
      { status: 403 },
    )
  }

  const jobId = enqueueJob("cf.bulk_set_ip", {
    key_id: keyId,
    domains: verified,
    new_ip: newIp,
    proxied,
  })
  appendAudit(
    "cf_bulk_set_ip",
    `cf_key=${keyId}`,
    `new_ip=${newIp} proxied=${proxied} count=${verified.length} job=${jobId}`,
    ip,
  )
  return NextResponse.json({ ok: true, job_id: jobId, count: verified.length })
}
