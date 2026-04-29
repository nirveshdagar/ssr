import { NextResponse, type NextRequest } from "next/server"
import { all, run } from "@/lib/db"
import { logPipeline } from "@/lib/repos/logs"

export const runtime = "nodejs"

interface DomainRow {
  domain: string
  status: string
}

interface ResultRow {
  domain: string
  before: string
  after: string
  http_status: number | null
  error: string | null
}

/**
 * On-demand status refresh — operator-initiated. Probes every `hosted` /
 * `live` domain under this CF key once via HTTPS and flips status based on
 * the result. Unlike the background live-checker (`lib/live-checker.ts`),
 * this is decisive: a single 2xx/3xx response flips `hosted` → `live`
 * immediately, no streak counter required, because the operator explicitly
 * asked for a refresh.
 *
 * Lives here (not on /api/domains) because the natural UX surface is the
 * per-key panel on /cloudflare — operator sees stale "hosted" rows for a
 * key, clicks "Refresh status", all 13 domains under that key get rechecked.
 *
 * The default automated live-checker is OFF (Flask-side runs it; running
 * both would cause status thrash). When operating Next.js standalone the
 * operator either sets `SSR_LIVE_CHECKER=1` for the background loop, or
 * uses this on-demand button.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const keyId = Number.parseInt(id, 10)
  if (!Number.isFinite(keyId)) {
    return NextResponse.json({ error: "invalid key id" }, { status: 400 })
  }

  const rows = all<DomainRow>(
    `SELECT domain, status FROM domains WHERE cf_key_id = ? AND status IN ('hosted','live') ORDER BY domain`,
    keyId,
  )
  if (rows.length === 0) {
    return NextResponse.json({
      ok: true, key_id: keyId, count: 0, flipped: 0,
      message: "No hosted / live domains under this CF key",
      results: [] as ResultRow[],
    })
  }

  // Bounded concurrency — same logic as the background live-checker so a
  // 60-domain key doesn't open 60 parallel connections to CF's edge.
  const PROBE_TIMEOUT_MS = 8000
  const PROBE_MAX_WORKERS = 20

  async function probeOne(d: DomainRow): Promise<ResultRow> {
    try {
      const res = await fetch(`https://${d.domain}/`, {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": "SSR-refresh-status/1.0" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      const ok = res.status >= 200 && res.status < 400
      const after = ok ? "live" : "hosted"
      if (after !== d.status) {
        run(
          `UPDATE domains SET status = ?, updated_at = datetime('now') WHERE domain = ?`,
          after, d.domain,
        )
        logPipeline(d.domain, "live_check", "completed",
          `Operator-initiated refresh: ${d.status} → ${after} (HTTP ${res.status})`)
      }
      return { domain: d.domain, before: d.status, after, http_status: res.status, error: null }
    } catch (e) {
      // Probe failure: leave status alone (we don't downgrade on a single
      // failed probe — could be transient network blip on the dashboard
      // side, not the origin). The background streak-based checker handles
      // sustained outages.
      return {
        domain: d.domain, before: d.status, after: d.status,
        http_status: null, error: (e as Error).message.slice(0, 200),
      }
    }
  }

  // Bounded-concurrency map (same shape as live-checker.ts:mapPool).
  const results = new Array<ResultRow>(rows.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= rows.length) return
      results[i] = await probeOne(rows[i])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PROBE_MAX_WORKERS, rows.length) }, () => worker()),
  )

  const flipped = results.filter((r) => r.before !== r.after).length
  const errored = results.filter((r) => r.error !== null).length
  return NextResponse.json({
    ok: true,
    key_id: keyId,
    count: rows.length,
    flipped,
    errored,
    message:
      `Probed ${rows.length} domain(s); flipped ${flipped}` +
      (errored > 0 ? `, ${errored} errored (status unchanged)` : ""),
    results,
  })
}
