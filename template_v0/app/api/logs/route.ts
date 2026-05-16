import { NextResponse, type NextRequest } from "next/server"
import { listPipelineLogs } from "@/lib/repos/logs"

export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const domain = url.searchParams.get("domain") || null
  const rawLimit = Number.parseInt(url.searchParams.get("limit") || "500", 10) || 500
  const limit = Math.min(Math.max(1, rawLimit), 5000)
  return NextResponse.json({ logs: listPipelineLogs({ domain, limit }) })
}
