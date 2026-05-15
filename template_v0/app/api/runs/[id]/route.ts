import { NextResponse, type NextRequest } from "next/server"
import { getRun, getStepRuns } from "@/lib/repos/runs"

export const runtime = "nodejs"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const run = getRun(Number(id))
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 })
  return NextResponse.json({ run, steps: getStepRuns(Number(id)) })
}
