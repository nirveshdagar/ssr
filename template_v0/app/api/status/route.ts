import { NextResponse, type NextRequest } from "next/server"
import { all, one } from "@/lib/db"
import { listDomains } from "@/lib/repos/domains"
import { listPipelineLogs } from "@/lib/repos/logs"

export const runtime = "nodejs"

/**
 * Dashboard + sidebar summary. Returns:
 *   - domains            — full list (used by dashboard activity tiles)
 *   - recent_logs        — last 10 pipeline_log rows
 *   - active_watchers    — domains with heartbeat in the last 5s
 *   - counts.{domains,servers,cf_keys,active_jobs,queued_jobs} — sidebar
 *     badges; cheap row counts so the sidebar doesn't need to fetch each
 *     list endpoint just to render a number.
 */
export async function GET(_req: NextRequest): Promise<Response> {
  const domains = listDomains()
  const recentLogs = listPipelineLogs({ limit: 10 })
  const fiveSecAgo = new Date(Date.now() - 5_000).toISOString().replace("T", " ").slice(0, 19)
  const active = all<{ domain: string }>(
    `SELECT domain FROM domains WHERE last_heartbeat_at > ?`, fiveSecAgo,
  ).map((r) => r.domain)

  const serverCount = one<{ n: number }>(`SELECT COUNT(*) AS n FROM servers`)?.n ?? 0
  const cfKeyCount = one<{ n: number }>(`SELECT COUNT(*) AS n FROM cf_keys`)?.n ?? 0
  const activeJobs = one<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'`)?.n ?? 0
  const queuedJobs = one<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'`)?.n ?? 0

  return NextResponse.json({
    domains,
    recent_logs: recentLogs,
    active_watchers: active,
    counts: {
      domains: domains.length,
      servers: serverCount,
      cf_keys: cfKeyCount,
      active_jobs: activeJobs,
      queued_jobs: queuedJobs,
      active_watchers: active.length,
    },
  })
}
