import { NextResponse, type NextRequest } from "next/server"
import { getDomain } from "@/lib/repos/domains"
import { listServers } from "@/lib/repos/servers"
import { installCustomSsl, findAppId } from "@/lib/serveravatar"
import { fetchOriginCaCert } from "@/lib/cloudflare"
import { appendAudit } from "@/lib/repos/audit"
import { logPipeline } from "@/lib/repos/logs"

export const runtime = "nodejs"

/**
 * Re-run the 3-tier SSL install for a single domain — API → patchright UI →
 * SSH fallback. Reuses the cached Origin CA cert on the domain row when
 * present; otherwise fetches a fresh 15-year cert from Cloudflare. Same
 * primitive step 8 of the pipeline uses.
 *
 * POST { domain }
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const domain = ((form?.get("domain") as string | null) || "").trim()
  if (!domain) {
    return NextResponse.json({ ok: false, error: "domain required" }, { status: 400 })
  }
  const d = getDomain(domain)
  if (!d) {
    return NextResponse.json({ ok: false, error: `unknown domain '${domain}'` }, { status: 404 })
  }
  const server = d.server_id
    ? listServers().find((s) => s.id === d.server_id) ?? null
    : null
  if (!server || !server.sa_server_id || !server.ip) {
    return NextResponse.json({
      ok: false,
      error: "domain has no linked SA server with sa_server_id + ip",
    }, { status: 400 })
  }

  // Cert source: cached on the domain row, else issue fresh
  let certPem = (d.origin_cert_pem ?? "").trim()
  let keyPem = (d.origin_key_pem ?? "").trim()
  let chainPem = ""
  if (!certPem || !keyPem) {
    try {
      const bundle = await fetchOriginCaCert(domain)
      certPem = bundle.certificate
      keyPem = bundle.private_key
      chainPem = bundle.chain
      logPipeline(domain, "sa_control", "running",
        `Fresh Origin CA issued (cached cert was missing)`)
    } catch (e) {
      return NextResponse.json({
        ok: false,
        error: `Origin CA issue failed: ${(e as Error).message}`,
      }, { status: 502 })
    }
  }

  let appId: string
  try {
    const found = await findAppId(server.sa_server_id, domain)
    if (!found) throw new Error(`SA app for ${domain} not found on server #${server.id}`)
    appId = found
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 })
  }

  try {
    const r = await installCustomSsl({
      saServerId: server.sa_server_id,
      appId,
      certificatePem: certPem,
      privateKeyPem: keyPem,
      chainPem,
      forceHttps: true,
      domain,
      serverIp: server.ip,
    })
    appendAudit("sa_reinstall_ssl", domain,
      `ok=${r.ok} server=${server.id} app=${appId}`, ip)
    return NextResponse.json({
      ok: r.ok, message: r.message,
    }, { status: r.ok ? 200 : 502 })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 })
  }
}
