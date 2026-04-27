import { NextResponse, type NextRequest } from "next/server"
import { getZoneStatus } from "@/lib/cloudflare"
import { listDomains } from "@/lib/repos/domains"

export const runtime = "nodejs"

/**
 * Probe Cloudflare zone status for every domain that has CF credentials on
 * its row. Returns a counts dict; mirrors Flask /api/domains/check-all-ns.
 *
 * Sequential (not parallel) to keep CF rate-limits safe with large fleets.
 */
export async function POST(_req: NextRequest): Promise<Response> {
  const results = { active: 0, pending: 0, errors: 0 }
  const domains = listDomains()
  for (const d of domains) {
    if (!d.cf_email || !d.cf_global_key) continue
    try {
      const status = await getZoneStatus(d.domain)
      if (status === "active") results.active++
      else results.pending++
    } catch {
      results.errors++
    }
  }
  return NextResponse.json({ ok: true, ...results })
}
