import { NextResponse, type NextRequest } from "next/server"
import { editCfKey, getCfKey } from "@/lib/repos/cf-keys"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Edit a CF key's alias + max_domains. Email + api_key are intentionally NOT
 * editable — re-add a fresh key instead so the verify-on-add flow runs.
 *
 * max_domains range 1..1000 (matches Flask).
 */
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
  const form = await req.formData().catch(() => null)
  const alias = ((form?.get("alias") as string | null) || "").trim() || null
  const maxDomainsRaw = ((form?.get("max_domains") as string | null) || "").trim()
  const maxDomains = Number.parseInt(maxDomainsRaw, 10)
  if (!Number.isFinite(maxDomains)) {
    return NextResponse.json({ ok: false, error: "max_domains must be an integer" }, { status: 400 })
  }
  if (maxDomains < 1 || maxDomains > 1000) {
    return NextResponse.json({ ok: false, error: "max_domains must be between 1 and 1000" }, { status: 400 })
  }
  if (!getCfKey(keyId)) {
    return NextResponse.json({ ok: false, error: "Key not found" }, { status: 404 })
  }
  editCfKey(keyId, alias, maxDomains)
  appendAudit("cf_key_edit", String(keyId), `alias=${alias ?? ""} max=${maxDomains}`, ip)
  return NextResponse.json({ ok: true, message: `CF key #${keyId} updated` })
}
