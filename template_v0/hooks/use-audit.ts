"use client"

import useSWR from "swr"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export interface AuditRow {
  id: string
  ts: string
  actor: string
  action: string
  target: string
  detail: string
}

interface ApiAudit {
  id: number
  created_at: string
  actor_ip: string | null
  action: string
  target: string | null
  detail: string | null
}

export function useAudit(opts: { action?: string | null; q?: string | null; page?: number } = {}) {
  const params = new URLSearchParams()
  if (opts.action) params.set("action", opts.action)
  if (opts.q) params.set("q", opts.q)
  if (opts.page) params.set("page", String(opts.page))
  const qs = params.toString()
  const { data, error, isLoading, mutate } = useSWR<{
    rows: ApiAudit[]
    total: number
    actions: { action: string; n: number }[]
    page: number
    last_page: number
  }>(`/api/audit${qs ? "?" + qs : ""}`, fetcher, { refreshInterval: 10000 })

  const rows: AuditRow[] = (data?.rows ?? []).map((a) => ({
    id: String(a.id),
    ts: a.created_at,
    actor: a.actor_ip || "system",
    action: a.action,
    target: a.target ?? "",
    detail: a.detail ?? "",
  }))
  return {
    rows,
    total: data?.total ?? 0,
    actions: data?.actions ?? [],
    page: data?.page ?? 1,
    lastPage: data?.last_page ?? 1,
    error,
    isLoading,
    refresh: mutate,
  }
}
