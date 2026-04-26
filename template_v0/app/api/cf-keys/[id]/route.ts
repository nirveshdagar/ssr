import { NextResponse, type NextRequest } from "next/server"
import { deleteCfKey, editCfKey, getCfKey, toggleCfKeyActive } from "@/lib/repos/cf-keys"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const row = getCfKey(Number(id))
  if (!row) return NextResponse.json({ error: "Key not found" }, { status: 404 })
  // Don't return api_key — even authed.
  const { api_key: _omit, ...safe } = row as typeof row & { api_key?: string }
  return NextResponse.json({ cf_key: safe })
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const result = deleteCfKey(Number(id))
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 409 })
  appendAudit("cf_key_delete", id, "Removed from pool", ip)
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const action = (form?.get("action") as string | null) || "edit"

  if (action === "toggle") {
    if (!toggleCfKeyActive(Number(id))) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 })
    }
    appendAudit("cf_key_toggle", id, "Toggled active flag", ip)
    return NextResponse.json({ ok: true })
  }

  // edit
  const alias = ((form?.get("alias") as string | null) || "").trim() || null
  const max = Number.parseInt((form?.get("max_domains") as string | null) || "", 10)
  if (!Number.isFinite(max) || max < 1 || max > 1000) {
    return NextResponse.json({ error: "max_domains must be 1-1000" }, { status: 400 })
  }
  if (!getCfKey(Number(id))) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 })
  }
  editCfKey(Number(id), alias, max)
  appendAudit("cf_key_edit", id, `alias=${alias} max_domains=${max}`, ip)
  return NextResponse.json({ ok: true })
}
