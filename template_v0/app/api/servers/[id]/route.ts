import { NextResponse, type NextRequest } from "next/server"
import { countDomainsOnServer, deleteServerRow, getServer, updateServer } from "@/lib/repos/servers"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const row = getServer(Number(id))
  if (!row) return NextResponse.json({ error: "Server not found" }, { status: 404 })
  return NextResponse.json({ server: row })
}

/**
 * Soft delete: drops dashboard row only. Mirrors Flask api_db_delete_server.
 * Does NOT touch the DO droplet or SA server record. Refuses if any
 * domain still references this server.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const sid = Number(id)
  const row = getServer(sid)
  if (!row) return NextResponse.json({ error: "Server not found" }, { status: 404 })

  const refs = countDomainsOnServer(sid)
  if (refs > 0) {
    return NextResponse.json(
      { error: `Cannot remove — ${refs} domain(s) still reference this server` },
      { status: 409 },
    )
  }
  deleteServerRow(sid)
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  appendAudit("server_db_delete", String(sid), `name=${row.name} ip=${row.ip}`, ip)
  return NextResponse.json({ ok: true })
}

/**
 * Edit name + max_sites. Mirrors Flask api_edit_server. Validates
 * length + range; 1 <= max_sites <= 500.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const sid = Number(id)
  const form = await req.formData().catch(() => null)
  const name = ((form?.get("name") as string | null) || "").trim()
  const maxRaw = (form?.get("max_sites") as string | null) || ""
  const max_sites = Number.parseInt(maxRaw, 10)

  if (!name || name.length > 64) {
    return NextResponse.json({ error: "name must be 1-64 characters" }, { status: 400 })
  }
  if (!Number.isFinite(max_sites) || max_sites < 1 || max_sites > 500) {
    return NextResponse.json({ error: "max_sites must be 1-500" }, { status: 400 })
  }
  if (!getServer(sid)) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 })
  }
  updateServer(sid, { name, max_sites })
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  appendAudit("server_edit", String(sid), `name=${name} max_sites=${max_sites}`, ip)
  return NextResponse.json({ ok: true })
}
