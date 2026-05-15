import { NextResponse, type NextRequest } from "next/server"
import { probeKeyDomains } from "@/lib/cf-key-probe"

export const runtime = "nodejs"

/**
 * On-demand status refresh for ONE CF key. Probes every hosted/live domain
 * under it once via HTTPS and flips status decisively (single 2xx/3xx →
 * live). Default automated live-checker is OFF; this is the operator's
 * manual escape hatch. Implementation lives in `lib/cf-key-probe.ts` so
 * the bulk variant can't drift.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const keyId = Number.parseInt(id, 10)
  if (!Number.isFinite(keyId)) {
    return NextResponse.json({ error: "invalid key id" }, { status: 400 })
  }

  const summary = await probeKeyDomains(keyId)
  if (summary.count === 0) {
    return NextResponse.json({
      ok: true, ...summary,
      message: "No hosted / live domains under this CF key",
    })
  }
  return NextResponse.json({
    ok: true,
    ...summary,
    message:
      `Probed ${summary.count} domain(s); flipped ${summary.flipped}` +
      (summary.errored > 0 ? `, ${summary.errored} errored (status unchanged)` : ""),
  })
}
