import { NextResponse, type NextRequest } from "next/server"
import { runFullPipeline } from "@/lib/pipeline"
import { getDomain } from "@/lib/repos/domains"

export const runtime = "nodejs"

/**
 * Kick off a full pipeline run for `domain`. Optional form params:
 *   skip_purchase=on  — skip step 1 purchase (BYO domain)
 *   server_id=N       — pin to a specific server (else round-robin)
 *   start_from=N      — resume from step N (1-10)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
): Promise<Response> {
  const { domain } = await params
  if (!getDomain(domain)) {
    return NextResponse.json(
      { ok: false, error: `Unknown domain '${domain}' — add it first` },
      { status: 404 },
    )
  }
  const form = await req.formData().catch(() => null)
  const skipPurchase = ((form?.get("skip_purchase") as string | null) || "") === "on"
  const serverIdRaw = ((form?.get("server_id") as string | null) || "").trim()
  const startFromRaw = ((form?.get("start_from") as string | null) || "").trim()
  const serverId = serverIdRaw ? Number.parseInt(serverIdRaw, 10) : null
  const startFrom = startFromRaw ? Number.parseInt(startFromRaw, 10) : null
  const jobId = runFullPipeline(domain, { skipPurchase, serverId, startFrom })
  if (jobId == null) {
    return NextResponse.json({
      ok: false,
      message: `Pipeline for ${domain} already running — request ignored`,
    })
  }
  return NextResponse.json({ ok: true, job_id: jobId, message: `Pipeline started for ${domain}` })
}
