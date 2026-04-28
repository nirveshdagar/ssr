import { NextResponse, type NextRequest } from "next/server"
import { addServer, updateServer } from "@/lib/repos/servers"
import { addDomain, getDomain, updateDomain } from "@/lib/repos/domains"
import { listApplications } from "@/lib/serveravatar"
import { appendAudit } from "@/lib/repos/audit"
import { logPipeline } from "@/lib/repos/logs"

export const runtime = "nodejs"

/**
 * Manual server registration. Required: name + ip. Optional: sa_server_id.
 *
 * If sa_server_id is provided, the new row is marked status='ready' AND we
 * walk SA's applications endpoint to auto-detect any domain currently hosted
 * on this server. Each app's primary_domain becomes a domain row pointed at
 * this server (status='hosted'), or — if a row with the same domain name
 * already exists — gets re-linked to this server.
 *
 * This is the "round-trip" flow for the soft-delete cascade: an operator
 * who soft-deleted a server (cascading every domain row) can re-add the
 * server here and have all the domains repopulate automatically without
 * a manual import per row.
 *
 * If no sa_server_id is provided the row is still added at status='ready'
 * (matches the prior behavior; useful for hardware not under SA).
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const name = ((form?.get("name") as string | null) || "").trim()
  const serverIp = ((form?.get("ip") as string | null) || "").trim()
  const saServerId = ((form?.get("sa_server_id") as string | null) || "").trim()
  if (!name || !serverIp) {
    return NextResponse.json({ ok: false, error: "name and ip are required" }, { status: 400 })
  }
  const sid = addServer(name, serverIp)
  if (saServerId) {
    updateServer(sid, { sa_server_id: saServerId, status: "ready" })
  } else {
    updateServer(sid, { status: "ready" })
  }

  // Auto-detect domains hosted on this SA server, link them to the new row.
  const detected: { domain: string; relinked: boolean }[] = []
  let listError: string | null = null
  if (saServerId) {
    try {
      const apps = await listApplications(saServerId)
      for (const app of apps) {
        const domain = String(app.primary_domain ?? "").trim()
        if (!domain) continue
        const existing = getDomain(domain)
        if (existing) {
          // Already in DB — relink to this server. Don't clobber CF / status
          // unless they're empty (preserve operator overrides).
          updateDomain(domain, {
            server_id: sid,
            current_proxy_ip: serverIp,
          } as Parameters<typeof updateDomain>[1])
          detected.push({ domain, relinked: true })
        } else {
          // Fresh row — link to this server, mark hosted.
          addDomain(domain)
          updateDomain(domain, {
            server_id: sid,
            current_proxy_ip: serverIp,
            status: "hosted",
          } as Parameters<typeof updateDomain>[1])
          detected.push({ domain, relinked: false })
        }
      }
    } catch (e) {
      listError = (e as Error).message
      logPipeline(name, "server_add_existing", "warning",
        `SA listApplications failed (${listError}) — server added but no domain auto-detect`)
    }
  }

  appendAudit("server_add_existing", String(sid),
    `name=${name} ip=${serverIp} sa_id=${saServerId || ""} detected=${detected.length}`, ip)
  if (detected.length > 0) {
    logPipeline(name, "server_add_existing", "completed",
      `Server #${sid} added + auto-detected ${detected.length} domain(s) from SA: ` +
      detected.map((d) => d.domain + (d.relinked ? "*" : "")).join(", "))
  }

  const newCount = detected.filter((d) => !d.relinked).length
  const relinkedCount = detected.filter((d) => d.relinked).length
  const detail = listError
    ? ` (SA list failed: ${listError} — re-run later or add domains manually)`
    : detected.length === 0
      ? ""
      : ` · auto-detected ${detected.length} domain(s) (${newCount} new, ${relinkedCount} relinked)`
  return NextResponse.json({
    ok: true,
    id: sid,
    detected_domains: detected,
    list_error: listError,
    message: `Server added: ${name} (${serverIp})${detail}`,
  })
}
