import { NextResponse, type NextRequest } from "next/server"
import { enqueueJob } from "@/lib/jobs"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/** Provision a fresh DO droplet + install SA agent (job runs in background). */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const name = (((form?.get("name") as string | null) || "ssr-server")).trim() || "ssr-server"
  const region = (((form?.get("region") as string | null) || "nyc1")).trim() || "nyc1"
  const size = (((form?.get("size") as string | null) || "s-1vcpu-1gb")).trim() || "s-1vcpu-1gb"
  const jobId = enqueueJob("server.create", { name, region, size })
  appendAudit("server_create_enqueue", name, `region=${region} size=${size} job=${jobId}`, ip)
  return NextResponse.json({
    ok: true, job_id: jobId,
    message: `Server creation started: ${name}`,
  })
}
