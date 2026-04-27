import { NextResponse, type NextRequest } from "next/server"
import { getWatcherSummary, getAllActiveWatchers } from "@/lib/repos/steps"

export const runtime = "nodejs"

/** All step_tracker rows grouped by domain + the active-pipeline list. */
export async function GET(_req: NextRequest): Promise<Response> {
  return NextResponse.json({
    watchers: getWatcherSummary(),
    active_domains: getAllActiveWatchers(),
  })
}
