"use client"

import useSWR from "swr"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export interface LogEvent {
  id: string
  ts: string
  level: "info" | "warn" | "error" | "debug"
  pipeline: string
  domain: string
  step: string
  message: string
}

interface ApiLog {
  id: number
  domain: string
  step: string
  status: string
  message: string | null
  created_at: string
}

const STATUS_TO_LEVEL: Record<string, LogEvent["level"]> = {
  completed: "info",
  running: "info",
  warning: "warn",
  failed: "error",
  blocked: "error",
}

export function useLogs(opts: { domain?: string | null; limit?: number } = {}) {
  const params = new URLSearchParams()
  if (opts.domain) params.set("domain", opts.domain)
  if (opts.limit) params.set("limit", String(opts.limit))
  const qs = params.toString()
  const { data, error, isLoading, mutate } = useSWR<{ logs: ApiLog[] }>(
    `/api/logs${qs ? "?" + qs : ""}`,
    fetcher,
    { refreshInterval: 8000, revalidateOnFocus: false },
  )
  const events: LogEvent[] = (data?.logs ?? []).map((l) => ({
    id: String(l.id),
    ts: l.created_at,
    level: STATUS_TO_LEVEL[l.status] ?? "debug",
    pipeline: `p_${l.id}`,
    domain: l.domain,
    step: l.step,
    message: l.message ?? "",
  }))
  return { events, error, isLoading, refresh: mutate }
}
