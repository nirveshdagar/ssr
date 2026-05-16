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
    // tag=null disables the filter — pull ALL droplets on the account, not
    // just ssr-server-tagged ones. Important: passing `tag: undefined` here
    // would silently fall back to the default ssr-server filter (the bug
    // pre-2026-05-01) and miss any droplets the operator tagged manually
    // or didn't tag at all.
    droplets = await listDroplets({ tag: null })
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

  // DO recycles public IPs: destroy a droplet, create a new one, and the
  // new (different-ID) droplet can get the destroyed one's IP. So dedupe
  // primarily by droplet ID. An IP collision only blocks import when the
  // colliding row is legitimately current — a manual row (no droplet_id)
  // or a row whose droplet is STILL live on DO. If every IP-colliding row
  // is for a destroyed droplet, this is a real new droplet (DO reused the
  // IP) and MUST import — otherwise it silently never syncs in.
  const liveDropletIds = new Set(droplets.map((d) => String(d.id)))
  const existingDropletIds = new Set<string>()
  const dropletIdsByIp = new Map<string, (string | null)[]>()
  for (const s of listServers()) {
    if (s.do_droplet_id) existingDropletIds.add(String(s.do_droplet_id))
    if (s.ip) {
      const arr = dropletIdsByIp.get(s.ip) ?? []
      arr.push(s.do_droplet_id ?? null)
      dropletIdsByIp.set(s.ip, arr)
    }
  }

  let added = 0
  let skipped = 0
  for (const d of droplets) {
    const dropletId = String(d.id)
    const name = d.name || `droplet-${dropletId}`
    const v4 = d.networks?.v4 ?? []
    const publicIp = v4.find((n) => n.type === "public")?.ip_address ?? ""
    if (!publicIp) continue
    if (existingDropletIds.has(dropletId)) { skipped++; continue }
    const ipRowIds = dropletIdsByIp.get(publicIp)
    if (ipRowIds && ipRowIds.length > 0) {
      // Skip only if a colliding row is a manual row (no droplet_id) or
      // points at a droplet that's still live; if all colliding rows are
      // stale destroyed-droplet rows, fall through and import this one.
      const stillCurrent = ipRowIds.some(
        (id) => id == null || liveDropletIds.has(String(id)),
      )
      if (stillCurrent) { skipped++; continue }
    }

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
