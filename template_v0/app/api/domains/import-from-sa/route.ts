import { NextResponse, type NextRequest } from "next/server"
import { getDb, all } from "@/lib/db"
import { listServers } from "@/lib/repos/servers"
import { addDomain, updateDomain } from "@/lib/repos/domains"
import { listServers as saListServers, listApplications } from "@/lib/serveravatar"
import { logPipeline } from "@/lib/repos/logs"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Pull every domain that's actually hosted on a ServerAvatar server (NOT all
 * Spaceship-registered domains). Mirrors Flask api_import_from_sa.
 *
 *   1. List SA servers in the org
 *   2. For each, list its applications
 *   3. For each app's primary_domain, INSERT into our domains table linked
 *      to THIS dashboard's server_id (matched by sa_server_id), with
 *      status='hosted'
 *   4. Auto-create a `servers` row for any SA server not already tracked
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  let saServers
  try {
    saServers = await saListServers()
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `ServerAvatar API error listing servers: ${(e as Error).message}` },
      { status: 502 },
    )
  }

  // Build sa_id → our_dashboard_server_id, creating rows for any SA server
  // we don't already track.
  const existing = new Map<string, number>()
  for (const s of listServers()) {
    if (s.sa_server_id) existing.set(String(s.sa_server_id), s.id)
  }
  const saToOurs = new Map<string, number>()
  let newServers = 0

  const db = getDb()
  for (const sa of saServers) {
    const saId = String(sa.id ?? "")
    if (!saId) continue
    if (existing.has(saId)) {
      saToOurs.set(saId, existing.get(saId)!)
      continue
    }
    const name = sa.name || `sa-srv-${saId}`
    const ipStr = (sa as { ip?: string }).ip ?? ""
    const result = db
      .prepare(
        `INSERT INTO servers(name, ip, do_droplet_id, sa_server_id, status)
         VALUES(?, ?, NULL, ?, 'ready')`,
      )
      .run(name, ipStr, saId)
    const ourId = Number(result.lastInsertRowid)
    saToOurs.set(saId, ourId)
    newServers++
  }

  // Pull every app on every SA server, insert any missing domains
  const existingDomains = new Set<string>(
    all<{ domain: string }>(`SELECT domain FROM domains`).map((d) => d.domain),
  )
  let added = 0
  let skipped = 0
  let errors = 0
  let totalApps = 0
  for (const sa of saServers) {
    const saId = String(sa.id ?? "")
    if (!saId) continue
    let apps
    try {
      apps = await listApplications(saId)
    } catch (e) {
      logPipeline(`server-${saId}`, "import_from_sa", "warning",
        `list_applications failed: ${(e as Error).message}`)
      errors++
      continue
    }
    totalApps += apps.length
    const ourId = saToOurs.get(saId)
    for (const app of apps) {
      let name = (app.primary_domain || app.name || (app as { url?: string }).url || "")
        .toString().trim().toLowerCase()
      name = name.replace(/^https?:\/\//, "").split("/")[0].trim()
      if (!name || !name.includes(".")) continue
      if (existingDomains.has(name)) { skipped++; continue }
      addDomain(name)
      if (ourId != null) {
        updateDomain(name, { server_id: ourId, status: "hosted" } as Parameters<typeof updateDomain>[1])
      } else {
        updateDomain(name, { status: "hosted" } as Parameters<typeof updateDomain>[1])
      }
      existingDomains.add(name)
      added++
    }
  }

  appendAudit(
    "import_from_sa", "",
    `added=${added} new_servers=${newServers} apps_seen=${totalApps} skipped=${skipped} errors=${errors}`,
    ip,
  )

  return NextResponse.json({
    ok: true,
    added, skipped, errors, total_apps: totalApps, new_servers: newServers,
    message: `Imported ${added} hosted domain(s) from ServerAvatar` +
      (newServers ? ` · ${newServers} new server row(s)` : "") +
      (skipped ? ` · ${skipped} already tracked` : "") +
      (errors ? ` · ${errors} SA server(s) failed` : "") + ".",
  })
}
