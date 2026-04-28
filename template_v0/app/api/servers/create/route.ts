import { NextResponse, type NextRequest } from "next/server"
import { enqueueJob } from "@/lib/jobs"
import { generateServerName } from "@/lib/server-names"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Provision a fresh DO droplet + install SA agent (job runs in background).
 *
 * Name handling: if the operator left the name field blank, the themed-word
 * generator picks an unused word + today's DD-MM-YYYY date (checked unique
 * across DB + SA + DO primary + DO backup). An explicit name is honored
 * verbatim — useful for ops naming conventions outside the auto pool.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const explicitName = ((form?.get("name") as string | null) || "").trim()
  const region = (((form?.get("region") as string | null) || "nyc1")).trim() || "nyc1"
  const size = (((form?.get("size") as string | null) || "s-1vcpu-1gb")).trim() || "s-1vcpu-1gb"

  let name: string
  if (explicitName) {
    name = explicitName
  } else {
    try {
      const gen = await generateServerName()
      name = gen.name
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: `Name generator failed: ${(e as Error).message}` },
        { status: 500 },
      )
    }
  }

  const jobId = enqueueJob("server.create", { name, region, size })
  appendAudit("server_create_enqueue", name, `region=${region} size=${size} job=${jobId}`, ip)
  return NextResponse.json({
    ok: true, job_id: jobId, name,
    message: `Server creation started: ${name}`,
  })
}
