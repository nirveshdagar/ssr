import { NextResponse, type NextRequest } from "next/server"
import { getServer, updateServer } from "@/lib/repos/servers"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Edit display name + max_sites cap. Caps mirror Flask exactly:
 *   name: 1–64 chars
 *   max_sites: 1–500 (SA's apparent ceiling is ~200; 500 gives headroom
 *     while still rejecting absurd typos).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const serverId = Number.parseInt(id, 10)
  if (!Number.isFinite(serverId)) {
    return NextResponse.json({ ok: false, error: "invalid server id" }, { status: 400 })
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const name = ((form?.get("name") as string | null) || "").trim()
  const maxSitesRaw = ((form?.get("max_sites") as string | null) || "").trim()
  const maxSites = Number.parseInt(maxSitesRaw, 10)
  if (!Number.isFinite(maxSites)) {
    return NextResponse.json({ ok: false, error: "max_sites must be an integer" }, { status: 400 })
  }
  if (name.length < 1 || name.length > 64) {
    return NextResponse.json({ ok: false, error: "name must be 1-64 characters" }, { status: 400 })
  }
  if (maxSites < 1 || maxSites > 500) {
    return NextResponse.json({ ok: false, error: "max_sites must be between 1 and 500" }, { status: 400 })
  }
  const existing = getServer(serverId)
  if (!existing) {
    return NextResponse.json({ ok: false, error: "Server not found" }, { status: 404 })
  }
  updateServer(serverId, { name, max_sites: maxSites })
  appendAudit("server_edit", String(serverId), `name=${JSON.stringify(name)} max_sites=${maxSites}`, ip)
  return NextResponse.json({ ok: true, message: `Server #${serverId} updated (name=${name}, max_sites=${maxSites})` })
}
