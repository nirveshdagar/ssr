import { NextResponse, type NextRequest } from "next/server"
import { toggleCfKeyActive } from "@/lib/repos/cf-keys"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/** Flip is_active on a CF key. Idempotent toggle. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const keyId = Number.parseInt(id, 10)
  if (!Number.isFinite(keyId)) {
    return NextResponse.json({ ok: false, error: "invalid key id" }, { status: 400 })
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  if (!toggleCfKeyActive(keyId)) {
    return NextResponse.json({ ok: false, error: "Key not found" }, { status: 404 })
  }
  appendAudit("cf_key_toggle", String(keyId), "", ip)
  return NextResponse.json({ ok: true, message: `CF key #${keyId} active flag toggled` })
}
