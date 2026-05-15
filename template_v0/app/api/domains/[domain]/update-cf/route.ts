import { NextResponse, type NextRequest } from "next/server"
import { updateDomain } from "@/lib/repos/domains"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

const ALLOWED = new Set(["cf_email", "cf_global_key", "cf_zone_id"])

/** Update CF credentials on a domain row. Empty values are ignored. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
): Promise<Response> {
  const { domain } = await params
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const updates: Record<string, string> = {}
  for (const k of ALLOWED) {
    const v = ((form?.get(k) as string | null) || "").trim()
    if (v) updates[k] = v
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: false, message: "No CF fields supplied" })
  }
  updateDomain(domain, updates as Parameters<typeof updateDomain>[1])
  appendAudit("domain_update_cf", domain, Object.keys(updates).join(","), ip)
  return NextResponse.json({ ok: true, message: `Updated CF credentials for ${domain}`, fields: Object.keys(updates) })
}
