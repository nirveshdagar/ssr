import { NextResponse, type NextRequest } from "next/server"
import { one } from "@/lib/db"

export const runtime = "nodejs"

/**
 * Unauthenticated liveness probe for uptime monitors and load balancers.
 * Returns 200 as long as the Node process is up AND the DB is readable.
 * Deliberately trivial — no secrets, no queries that could fail under load.
 *
 * Path lives at /healthz (not /api/healthz) so it can be excluded from the
 * auth middleware via the route-level matcher.
 */
export async function GET(_req: NextRequest): Promise<Response> {
  try {
    const r = one<{ x: number }>("SELECT 1 AS x")
    if (r?.x !== 1) {
      return NextResponse.json({ status: "degraded", error: "DB unexpected response" }, { status: 503 })
    }
    return NextResponse.json({ status: "ok" })
  } catch (e) {
    return NextResponse.json(
      { status: "degraded", error: (e as Error).message.slice(0, 100) },
      { status: 503 },
    )
  }
}
