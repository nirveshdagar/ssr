import { NextResponse, type NextRequest } from "next/server"
import { enqueueJob } from "@/lib/jobs"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Emergency kill-switch: enqueue a job that tears down every server with no
 * domain references. Caller MUST submit `confirm_phrase=DESTROY ALL` (exact
 * match) — anything else is rejected with 400.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const phrase = ((form?.get("confirm_phrase") as string | null) || "").trim()
  if (phrase !== "DESTROY ALL") {
    return NextResponse.json(
      { ok: false, error: "Emergency kill-switch requires typing exactly: DESTROY ALL" },
      { status: 400 },
    )
  }
  const jobId = enqueueJob("server.destroy_all", {})
  appendAudit("destroy_all_servers", "", `job=${jobId}`, ip)
  return NextResponse.json({
    ok: true, job_id: jobId,
    message:
      "Emergency destroy-all started — droplets being torn down in background. " +
      "Check pipeline log for per-server results.",
  })
}
