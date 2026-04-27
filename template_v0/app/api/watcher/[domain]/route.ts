import { NextResponse, type NextRequest } from "next/server"
import { getSteps } from "@/lib/repos/steps"

export const runtime = "nodejs"

/** All 10 step_tracker rows for one domain. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
): Promise<Response> {
  const { domain } = await params
  return NextResponse.json({ domain, steps: getSteps(domain) })
}
