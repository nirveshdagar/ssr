import { NextResponse, type NextRequest } from "next/server"
import { runAll } from "@/lib/preflight"

export const runtime = "nodejs"

/**
 * Run the 7 preflight checks. `domain` is currently unused (checks are global)
 * but is in the URL for future per-domain state checks without changing the
 * route shape.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url)
  const skipPurchase = url.searchParams.get("skip_purchase") === "on"
  const report = await runAll({ skipPurchase })
  return NextResponse.json(report)
}
