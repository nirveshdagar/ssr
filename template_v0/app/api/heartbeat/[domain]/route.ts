import { NextResponse, type NextRequest } from "next/server"
import { one } from "@/lib/db"

export const runtime = "nodejs"

/**
 * Most-recent pipeline heartbeat for a domain. Dashboard polls this every
 * second to show a live "pipeline alive" indicator. `alive=true` if the
 * heartbeat was written within the last 5 seconds.
 *
 * `last_heartbeat_at` is UTC, written as `datetime('now')`.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
): Promise<Response> {
  const { domain } = await params
  const row = one<{ last_heartbeat_at: string | null }>(
    "SELECT last_heartbeat_at FROM domains WHERE domain = ?", domain,
  )
  if (!row || !row.last_heartbeat_at) {
    return NextResponse.json({
      domain, last_heartbeat_at: null, seconds_ago: null, alive: false,
    })
  }
  // SQLite "YYYY-MM-DD HH:MM:SS" UTC → epoch
  const last = Date.parse(row.last_heartbeat_at.replace(" ", "T") + "Z")
  const ago = Math.max(0, Math.floor((Date.now() - last) / 1000))
  return NextResponse.json({
    domain,
    last_heartbeat_at: row.last_heartbeat_at,
    seconds_ago: ago,
    alive: ago < 5,
  })
}
