import { NextResponse, type NextRequest } from "next/server"
import { getDomain } from "@/lib/repos/domains"
import { listRunsForDomain } from "@/lib/repos/runs"

export const runtime = "nodejs"

export async function GET(req: NextRequest, ctx: { params: Promise<{ domain: string }> }) {
  const { domain } = await ctx.params
  if (!getDomain(domain)) return NextResponse.json({ error: "Domain not found" }, { status: 404 })
  const url = new URL(req.url)
  const limit = Number.parseInt(url.searchParams.get("limit") || "20", 10) || 20
  return NextResponse.json({ runs: listRunsForDomain(domain, limit) })
}
