import { NextResponse, type NextRequest } from "next/server"
import { getDomain, updateDomain } from "@/lib/repos/domains"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Hide a domain from the /watcher list without deleting it or touching its
 * real status (UI-only flag). Reset to 0 on pipeline run teardown, so a
 * fresh/auto-heal run re-surfaces it. An actively-running domain stays
 * visible regardless (the watcher filter overrides dismissal while active).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
): Promise<Response> {
  const { domain } = await params
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  if (!getDomain(domain)) {
    return NextResponse.json({ ok: false, message: `Unknown domain ${domain}` }, { status: 404 })
  }
  updateDomain(domain, { watcher_dismissed: 1 } as Parameters<typeof updateDomain>[1])
  appendAudit("watcher_dismiss", domain, "", ip)
  return NextResponse.json({
    ok: true,
    message: `${domain} removed from watcher (reappears if a pipeline runs again)`,
  })
}
