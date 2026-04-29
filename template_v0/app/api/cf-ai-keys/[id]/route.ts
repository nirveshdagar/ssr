import { NextResponse, type NextRequest } from "next/server"
import {
  deleteCfAiKey,
  editCfAiKeyAlias,
  getCfAiKey,
  toggleCfAiKeyActive,
} from "@/lib/repos/cf-ai-keys"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

interface RouteCtx {
  params: Promise<{ id: string }>
}

function resolveId(id: string): number | null {
  const n = parseInt(id, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params
  const n = resolveId(id)
  if (!n) return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 })
  if (!getCfAiKey(n)) {
    return NextResponse.json({ ok: false, error: "row not found" }, { status: 404 })
  }
  deleteCfAiKey(n)
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  appendAudit("cf_ai_key_delete", String(n), "removed from pool", ip)
  return NextResponse.json({ ok: true })
}

/**
 * PATCH /api/cf-ai-keys/[id]
 *   body: { action: "toggle" } or { action: "edit", alias: string|null }
 */
export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const { id } = await ctx.params
  const n = resolveId(id)
  if (!n) return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 })
  if (!getCfAiKey(n)) {
    return NextResponse.json({ ok: false, error: "row not found" }, { status: 404 })
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const action = String(body.action ?? "").trim()
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  if (action === "toggle") {
    toggleCfAiKeyActive(n)
    const after = getCfAiKey(n)
    appendAudit("cf_ai_key_toggle", String(n), `is_active=${after?.is_active ?? "?"}`, ip)
    return NextResponse.json({ ok: true, is_active: after?.is_active ?? 0 })
  }
  if (action === "edit") {
    const alias = body.alias == null ? null : String(body.alias).trim() || null
    editCfAiKeyAlias(n, alias)
    appendAudit("cf_ai_key_edit", String(n), `alias=${alias ?? ""}`, ip)
    return NextResponse.json({ ok: true })
  }
  return NextResponse.json({ ok: false, error: `unknown action: ${action}` }, { status: 400 })
}
