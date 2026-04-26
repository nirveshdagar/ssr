import { NextResponse, type NextRequest } from "next/server"
import { deleteDomain, getDomain, releaseCfKeySlot } from "@/lib/repos/domains"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ domain: string }> }) {
  const { domain } = await ctx.params
  const row = getDomain(domain)
  if (!row) return NextResponse.json({ error: "Domain not found" }, { status: 404 })
  return NextResponse.json({ domain: row })
}

/**
 * Soft-delete a domain: drop the dashboard row only. Releases the CF
 * pool slot first so cf_keys.domains_used stays accurate.
 * Mirrors Flask api_delete_domain.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ domain: string }> }) {
  const { domain } = await ctx.params
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  if (!getDomain(domain)) return NextResponse.json({ error: "Domain not found" }, { status: 404 })
  releaseCfKeySlot(domain)
  deleteDomain(domain)
  appendAudit("domain_db_delete", domain, "Soft delete (DB only)", ip)
  return NextResponse.json({ ok: true })
}
