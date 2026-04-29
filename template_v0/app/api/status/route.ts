import { NextResponse, type NextRequest } from "next/server"
import { one } from "@/lib/db"
import { listDomains } from "@/lib/repos/domains"
import { listPipelineLogs } from "@/lib/repos/logs"
import { getAllActiveWatchers } from "@/lib/repos/steps"

export const runtime = "nodejs"

/** Statuses that put a domain on the watcher page's "Active runs" list.
 *  Mirror of the filter in app/watcher/page.tsx so the sidebar badge stays
 *  in lockstep with what the page actually renders. */
const WATCHER_RUN_STATUSES = new Set([
  "running",
  "waiting",
  "retryable_error",
  "terminal_error",
  "canceled",
  // Raw DB states the use-domains mapper normalises into the above bucket;
  // include them too so a freshly-written status renders before SWR rehydrates.
  "error",
  "ns_pending_external",
  "manual_action_required",
  "waiting_dns",
  "owned_external",
  "content_blocked",
  "cf_pool_full",
  "purchase_failed",
])

/**
 * Dashboard + sidebar summary. Returns:
 *   - domains            — full list (used by dashboard activity tiles)
 *   - recent_logs        — last 10 pipeline_log rows
 *   - active_watchers    — domains with at least one step in 'running' state
 *                          (in-flight only — used by the dashboard "currently
 *                          active" tile, not the sidebar badge)
 *   - counts.watcher_runs — domains the /watcher page surfaces (in-flight
 *                          + retryable + terminal + waiting + canceled).
 *                          This is what the Watcher sidebar badge uses so the
 *                          number matches the page's "Active runs" header.
 *   - counts.{domains,servers,cf_keys,active_jobs,queued_jobs} — sidebar
 *     badges; cheap row counts so the sidebar doesn't need to fetch each
 *     list endpoint just to render a number.
 *
 * History: `active_watchers` was originally derived from
 * `last_heartbeat_at > now-5s`, but a step that blocks longer than one
 * heartbeat interval (LLM, SSH, etc.) would silently drop out of the count
 * even though the pipeline was still running. Switched to step_tracker.status
 * 2026-04-29. Then realised the badge needs to also surface stalled
 * retryable/terminal rows operators must act on — those have no running
 * step_tracker row but ARE listed on the watcher page — so the badge moved
 * to a separate `watcher_runs` count that matches the page filter.
 */
export async function GET(_req: NextRequest): Promise<Response> {
  const domains = listDomains()
  const recentLogs = listPipelineLogs({ limit: 10 })
  const active = getAllActiveWatchers()
  const watcherRuns = domains.filter((d) => WATCHER_RUN_STATUSES.has(d.status)).length

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
      watcher_runs: watcherRuns,
    },
  })
}
