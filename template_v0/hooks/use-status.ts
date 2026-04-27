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
  active_watchers: number
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

/** Dashboard polling — every 5s by default. */
export function useStatus(refreshMs = 5000) {
  const { data, error, isLoading, mutate } = useSWR<StatusResponse>(
    "/api/status", fetcher,
    { refreshInterval: refreshMs, revalidateOnFocus: false },
  )
  return { status: data, error, isLoading, mutate }
}
