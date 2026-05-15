"use client"
import useSWR from "swr"
import type { StepTrackerRow } from "@/lib/repos/steps"

export interface WatcherResponse {
  watchers: Record<string, StepTrackerRow[]>
  active_domains: string[]
}

export interface DomainWatcherResponse {
  domain: string
  steps: StepTrackerRow[]
}

const fetcher = async <T>(url: string): Promise<T> => {
  const r = await fetch(url, { credentials: "same-origin" })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json() as Promise<T>
}

/** All step_tracker rows grouped by domain — refreshes every 3s by default.
 *  Callers should bump faster (e.g. 1500ms) only while at least one run is
 *  active; idle dashboards keep this at 3s to stay cheap on a 2-CPU box. */
export function useWatcher(refreshMs = 3000) {
  const { data, error, isLoading, mutate } = useSWR<WatcherResponse>(
    "/api/watcher", fetcher<WatcherResponse>,
    { refreshInterval: refreshMs, revalidateOnFocus: false },
  )
  return { watcher: data, error, isLoading, mutate }
}

/** Per-domain step state — used by the heartbeat panel on the domains page.
 *  Pass `null` for `domain` to fully disable polling (e.g. when the pipeline
 *  is in a success/terminal state and there's nothing to watch). */
export function useDomainWatcher(domain: string | null, refreshMs = 3000) {
  const { data, error, isLoading } = useSWR<DomainWatcherResponse>(
    domain ? `/api/watcher/${domain}` : null,
    fetcher<DomainWatcherResponse>,
    { refreshInterval: refreshMs, revalidateOnFocus: false },
  )
  return { steps: data?.steps, error, isLoading }
}

export interface HeartbeatResponse {
  domain: string
  last_heartbeat_at: string | null
  seconds_ago: number | null
  alive: boolean
}

/** Live heartbeat — polled every 3s by default. Returns alive flag + how
 *  many seconds since the last heartbeat write. The watcher renders a
 *  colored chip (green ≤5s, amber ≤30s, red >30s) from this.
 *  Pass `null` for `domain` to disable polling entirely. */
export function useHeartbeat(domain: string | null, refreshMs = 3000) {
  const { data, error } = useSWR<HeartbeatResponse>(
    domain ? `/api/heartbeat/${domain}` : null,
    fetcher<HeartbeatResponse>,
    { refreshInterval: refreshMs, revalidateOnFocus: false },
  )
  return { heartbeat: data, error }
}
