import { NextResponse, type NextRequest } from "next/server"
import { isPipelineRunning } from "@/lib/pipeline"
import { updateDomain } from "@/lib/repos/domains"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/** Set cancel_requested=1 — the worker checks this between step boundaries. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
): Promise<Response> {
  const { domain } = await params
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  if (!isPipelineRunning(domain)) {
    return NextResponse.json({
      ok: false, message: `No pipeline running for ${domain}`,
    })
  }
  updateDomain(domain, { cancel_requested: 1 } as Parameters<typeof updateDomain>[1])
  appendAudit("pipeline_cancel", domain, "", ip)
  return NextResponse.json({
    ok: true,
    message: `Cancel requested for ${domain} — will stop at next step boundary`,
  })
}
