import { NextResponse, type NextRequest } from "next/server"
import { verifyOriginCertIsCustom } from "@/lib/serveravatar"
import { getDomain, updateDomain } from "@/lib/repos/domains"
import { getServer } from "@/lib/repos/servers"
import { logPipeline } from "@/lib/repos/logs"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

const SAFE_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

/**
 * Run a live TLS probe against the domain's origin and update
 * `ssl_origin_ok` + `ssl_last_verified_at` immediately. Same probe the
 * 5-min auto-heal sweep uses; this is the on-demand path so the operator
 * can re-verify a single row without waiting for the next tick.
 *
 * Returns the raw issuer/subject so the operator can see WHAT cert is
 * being served when the result disagrees with their expectation
 * (e.g. "I removed the cert but the lock is still green").
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
): Promise<Response> {
  const { domain } = await params
  if (!SAFE_DOMAIN.test(domain)) {
    return NextResponse.json({ ok: false, error: "invalid domain shape" }, { status: 400 })
  }
  const row = getDomain(domain)
  if (!row) {
    return NextResponse.json({ ok: false, error: `Unknown domain '${domain}'` }, { status: 404 })
  }
  if (!row.server_id) {
    return NextResponse.json({ ok: false, error: "domain has no server attached — nothing to probe" }, { status: 400 })
  }
  const server = getServer(row.server_id)
  const ip = server?.ip || row.current_proxy_ip
  if (!ip) {
    return NextResponse.json({ ok: false, error: "no IP for attached server" }, { status: 400 })
  }

  const probe = await verifyOriginCertIsCustom(ip, domain, 10_000)
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")

  if (probe.ok === true) {
    updateDomain(domain, {
      ssl_origin_ok: 1,
      ssl_last_verified_at: nowIso,
    } as Parameters<typeof updateDomain>[1])
    logPipeline(domain, "ssl_verify", "completed",
      `Manual re-probe: verified — issuer=${probe.issuerCN ?? "?"}`)
  } else if (probe.ok === false) {
    updateDomain(domain, {
      ssl_origin_ok: 0,
      ssl_last_verified_at: nowIso,
    } as Parameters<typeof updateDomain>[1])
    logPipeline(domain, "ssl_verify", "warning",
      `Manual re-probe: MISMATCH on ${ip} — ${probe.message}`)
    appendAudit(
      "ssl_origin_mismatch", domain,
      `manual re-probe: ip=${ip} subject="${probe.subjectCN ?? "?"}" issuer="${probe.issuerCN ?? "?"}"`,
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
    )
  } else {
    // Inconclusive (network error, timeout) — leave DB alone; surface to UI.
    logPipeline(domain, "ssl_verify", "warning",
      `Manual re-probe inconclusive: ${probe.message}`)
  }

  return NextResponse.json({
    ok: true,
    probed_ip: ip,
    result: probe.ok,            // true | false | null
    issuer: probe.issuerCN,
    subject: probe.subjectCN,
    message: probe.message,
    ssl_last_verified_at: probe.ok === null ? row.ssl_last_verified_at : nowIso,
  })
}
