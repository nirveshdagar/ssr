import { NextResponse, type NextRequest } from "next/server"
import { enqueueJob } from "@/lib/jobs"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/** Enqueue full teardown (SA + CF + Spaceship + DB + slot + archive). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
): Promise<Response> {
  const { domain } = await params
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const jobId = enqueueJob("domain.teardown", { domain })
  appendAudit("domain_full_delete", domain, `job=${jobId}`, ip)
  return NextResponse.json({
    ok: true, job_id: jobId,
    message: `Full deletion started for ${domain} (SA + CF + Spaceship + DB)`,
  })
}
