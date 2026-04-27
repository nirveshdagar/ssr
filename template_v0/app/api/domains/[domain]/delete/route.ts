import { NextResponse, type NextRequest } from "next/server"
import { deleteDomain } from "@/lib/repos/domains"
import { releaseCfKeySlot } from "@/lib/cf-key-pool"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Soft delete: release CF pool slot, then drop the row. Order matters —
 * releaseCfKeySlot reads cf_key_id from the domains row, so once the row
 * is gone the slot leaks and cf_keys.domains_used drifts up forever.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
): Promise<Response> {
  const { domain } = await params
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  releaseCfKeySlot(domain)
  deleteDomain(domain)
  appendAudit("domain_delete", domain, "soft delete (DB only)", ip)
  return NextResponse.json({ ok: true, message: `Deleted ${domain} from dashboard` })
}
