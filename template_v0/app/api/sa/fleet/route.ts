import { NextResponse } from "next/server"
import { listFleet } from "@/lib/sa-control"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Live fleet view — every SA server with stats + apps joined against
 * SSR's domain table for heartbeat/status. Single round trip from the
 * client; SA-side is parallelized at concurrency 5 in lib/sa-control.
 */
export async function GET(): Promise<Response> {
  try {
    const servers = await listFleet()
    return NextResponse.json({ ok: true, servers, fetched_at: new Date().toISOString() })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 502 },
    )
  }
}
