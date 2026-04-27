import { NextResponse, type NextRequest } from "next/server"
import { getZoneStatus } from "@/lib/cloudflare"
import { updateDomain } from "@/lib/repos/domains"

export const runtime = "nodejs"

/**
 * Probe Cloudflare zone status for a single domain. If active, flip
 * domain.status to 'ns_set' (matches Flask's after-NS-detected nudge).
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
): Promise<Response> {
  const { domain } = await params
  try {
    const status = await getZoneStatus(domain)
    if (status === "active") {
      updateDomain(domain, { status: "ns_set" })
      return NextResponse.json({ ok: true, status, message: `${domain}: NS propagated — zone ACTIVE` })
    }
    return NextResponse.json({
      ok: false, status,
      message: `${domain}: zone status is '${status}' — NS not yet propagated`,
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: `NS check failed: ${(e as Error).message}` }, { status: 500 })
  }
}
