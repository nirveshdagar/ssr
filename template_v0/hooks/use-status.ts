"use client"
import useSWR from "swr"
import type { DomainRow } from "@/lib/repos/domains"
import type { PipelineLogRow } from "@/lib/repos/logs"

export interface StatusCounts {
  domains: number
  servers: number
  cf_keys: number
  active_jobs: number
  queued_jobs: number
  /** Domains with a step_tracker row in 'running' state — i.e. in-flight
   *  pipelines only. Used by the dashboard "currently active" tile. */
  active_watchers: number
  /** Domains the /watcher page renders (in-flight + retryable + terminal
   *  + waiting + canceled). Used by the Watcher sidebar badge so its count
   *  matches the "Active runs" header on the page. */
  watcher_runs: number
}

export interface StatusResponse {
  domains: DomainRow[]
  recent_logs: PipelineLogRow[]
  active_watchers: string[]
  counts: StatusCounts
}

const fetcher = async (url: string): Promise<StatusResponse> => {
  const r = await fetch(url, { credentials: "same-origin" })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/** Dashboard polling — every 8s by default. */
export function useStatus(refreshMs = 8000) {
  const { data, error, isLoading, mutate } = useSWR<StatusResponse>(
    "/api/status", fetcher,
    { refreshInterval: refreshMs, revalidateOnFocus: false },
  )
  return { status: data, error, isLoading, mutate }
}
