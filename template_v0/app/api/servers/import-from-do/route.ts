import { NextResponse, type NextRequest } from "next/server"
import { listDroplets, DOAllTokensFailed } from "@/lib/digitalocean"
import { listServers, addServer, updateServer } from "@/lib/repos/servers"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Pull every droplet DO returns and add DB rows for anything we don't
 * already know about. Does NOT install SA — operator wires that up
 * separately. Newly-imported rows get status='detected' so the pipeline
 * treats them as unready until SA is hooked up.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  let droplets
  try {
    // No tag filter — pull ALL droplets so the operator can see the full fleet
    droplets = await listDroplets({ tag: undefined })
  } catch (e) {
    if (e instanceof DOAllTokensFailed) {
      return NextResponse.json(
        { ok: false, error: `DO API rejected both tokens: ${e.message}` },
        { status: 502 },
      )
    }
    return NextResponse.json(
      { ok: false, error: `DO API error: ${(e as Error).message}` },
      { status: 502 },
    )
  }

  const existingDropletIds = new Set<string>()
  const existingIps = new Set<string>()
  for (const s of listServers()) {
    if (s.do_droplet_id) existingDropletIds.add(String(s.do_droplet_id))
    if (s.ip) existingIps.add(s.ip)
  }

  let added = 0
  let skipped = 0
  for (const d of droplets) {
    const dropletId = String(d.id)
    const name = d.name || `droplet-${dropletId}`
    const v4 = d.networks?.v4 ?? []
    const publicIp = v4.find((n) => n.type === "public")?.ip_address ?? ""
    if (!publicIp) continue
    if (existingDropletIds.has(dropletId) || existingIps.has(publicIp)) { skipped++; continue }

    const sid = addServer(name, publicIp, dropletId)
    updateServer(sid, {
      status: "detected",
      region: d.region?.slug ?? null,
      size_slug: d.size_slug ?? null,
    } as Parameters<typeof updateServer>[1])
    added++
  }

  appendAudit("import_from_do", "", `added=${added} skipped=${skipped}`, ip)
  return NextResponse.json({
    ok: true, added, skipped, total: droplets.length,
    message: added > 0
      ? `Imported ${added} droplet(s) from DigitalOcean. Wire up SA agent before running pipelines.`
      : `No new droplets to import (already had ${skipped} of ${droplets.length}).`,
  })
}
