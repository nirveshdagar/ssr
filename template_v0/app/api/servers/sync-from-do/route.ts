import { NextResponse, type NextRequest } from "next/server"
import { all, run } from "@/lib/db"
import { listDroplets } from "@/lib/digitalocean"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Reverse of import-from-do: drop dashboard rows whose DO droplet has
 * been destroyed upstream. Mirrors the Flask api_servers_sync_from_do.
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  let live: Set<number>
  try {
    const droplets = await listDroplets()
    live = new Set(droplets.map((d) => Number(d.id)))
  } catch (e) {
    return NextResponse.json({ error: `DO list failed: ${(e as Error).message}` }, { status: 502 })
  }

  const rows = all<{ id: number; name: string; ip: string; do_droplet_id: string }>(
    "SELECT id, name, ip, do_droplet_id FROM servers WHERE do_droplet_id IS NOT NULL",
  )
  const removed: string[] = []
  const blocked: string[] = []
  let kept = 0
  for (const r of rows) {
    if (live.has(Number(r.do_droplet_id))) {
      kept++
      continue
    }
    const refRow = all<{ n: number }>("SELECT COUNT(*) AS n FROM domains WHERE server_id = ?", r.id)
    const refs = refRow[0]?.n ?? 0
    if (refs > 0) {
      blocked.push(`${r.name} (${refs} domain(s))`)
      continue
    }
    run("DELETE FROM servers WHERE id = ?", r.id)
    removed.push(r.name || `srv-${r.id}`)
  }

  appendAudit(
    "servers_sync_from_do",
    "",
    `removed=${removed.length} kept=${kept} blocked=${blocked.length}`,
    ip,
  )
  return NextResponse.json({
    ok: true,
    removed,
    kept,
    blocked,
  })
}
