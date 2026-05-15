import { NextResponse, type NextRequest } from "next/server"
import { probeLive } from "@/lib/live-checker"
import { getDomain } from "@/lib/repos/domains"
import { run } from "@/lib/db"

export const runtime = "nodejs"

const SAFE_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

/**
 * Force a fresh HTTPS liveness probe for one domain. Same probe the
 * live-checker tick uses; bypasses the streak counter and writes the
 * result straight to the live_* columns so the dashboard reflects it
 * on the next refresh.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
): Promise<Response> {
  const { domain } = await params
  if (!SAFE_DOMAIN.test(domain)) {
    return NextResponse.json({ ok: false, error: "invalid domain shape" }, { status: 400 })
  }
  if (!getDomain(domain)) {
    return NextResponse.json({ ok: false, error: `Unknown domain '${domain}'` }, { status: 404 })
  }

  const probe = await probeLive(domain)
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
  const contentVal = probe.contentOk === true ? 1 : probe.contentOk === false ? 0 : null
  const contentCheckedAt = probe.contentOk !== null ? nowIso : null
  run(
    `UPDATE domains
        SET live_ok = ?, live_reason = ?, live_http_status = ?, live_checked_at = ?,
            content_ok = COALESCE(?, content_ok),
            content_checked_at = COALESCE(?, content_checked_at)
      WHERE domain = ?`,
    probe.ok ? 1 : 0, probe.reason, probe.status, nowIso,
    contentVal, contentCheckedAt,
    domain,
  )

  return NextResponse.json({
    ok: true,
    result: probe.ok,
    reason: probe.reason,
    http_status: probe.status,
    content_ok: probe.contentOk,
    checked_at: nowIso,
  })
}
