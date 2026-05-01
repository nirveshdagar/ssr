import { NextResponse, type NextRequest } from "next/server"
import { enqueueJob } from "@/lib/jobs"
import { generateServerName } from "@/lib/server-names"
import { appendAudit } from "@/lib/repos/audit"
import { getSetting } from "@/lib/repos/settings"

export const runtime = "nodejs"

// Same shape the auto-generator emits — ASCII safe for DO droplet hostnames,
// SA server-name field, and any future automation that interpolates the name.
// Rejecting non-conforming input here keeps shell metacharacters / ANSI
// sequences out of downstream cloud-init scripts and operator log tails.
const SAFE_NAME = /^[a-z0-9-]{1,63}$/

/**
 * Provision a fresh DO droplet + install SA agent (job runs in background).
 *
 * Name handling: if the operator left the name field blank, the themed-word
 * generator picks an unused word + today's DD-MM-YYYY date (checked unique
 * across DB + SA + DO primary + DO backup). An explicit name is honored
 * verbatim if it matches SAFE_NAME — useful for ops naming conventions
 * outside the auto pool.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const explicitName = ((form?.get("name") as string | null) || "").trim()
  // Region / size fallback chain: explicit form value → setting →
  // legacy hardcode. Lets the operator set a fleet-wide default in
  // /settings → DigitalOcean instead of editing the form every time.
  const formRegion = ((form?.get("region") as string | null) || "").trim()
  const formSize = ((form?.get("size") as string | null) || "").trim()
  const region = formRegion || (getSetting("do_default_region") || "").trim() || "nyc1"
  const size = formSize || (getSetting("do_default_size") || "").trim() || "s-1vcpu-1gb"

  let name: string
  if (explicitName) {
    if (!SAFE_NAME.test(explicitName)) {
      return NextResponse.json(
        { ok: false, error: "name must match [a-z0-9-]{1,63}" },
        { status: 400 },
      )
    }
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

  // Pre-flight DO availability check. Without this, an invalid region+size
  // combo would silently enqueue a doomed background job — operator gets a
  // green "Droplet creation enqueued" toast, the modal closes, and the job
  // fails 5-15s later in pipeline_log with no UI surface. Operator stares
  // at /servers expecting a new row and sees nothing. Surfacing here as a
  // 422 with the regions where the size IS available means the operator
  // can fix the dropdown selection on the spot.
  try {
    const { validateRegionSize } = await import("@/lib/digitalocean")
    const v = await validateRegionSize(region, size)
    if (!v.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: v.error ?? "region/size combo invalid",
          available_regions: v.available_regions,
        },
        { status: 422 },
      )
    }
  } catch { /* validator threw — let createDroplet surface the underlying error */ }

  const jobId = enqueueJob("server.create", { name, region, size })
  appendAudit("server_create_enqueue", name, `region=${region} size=${size} job=${jobId}`, ip)
  return NextResponse.json({
    ok: true, job_id: jobId, name,
    message: `Server creation started: ${name}`,
  })
}
