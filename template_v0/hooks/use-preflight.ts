"use client"

import useSWR from "swr"

export interface PreflightCheck {
  ok: boolean
  message: string
  detail?: Record<string, unknown>
}
export interface PreflightReport {
  ok: boolean
  checks: Record<string, PreflightCheck>
}

const fetcher = async (url: string): Promise<PreflightReport> => {
  const r = await fetch(url, { credentials: "same-origin" })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/**
 * Environment-wide config health. Polls slowly (5 min) — each call hits
 * Cloudflare/DO/SA/Spaceship, so don't hammer them; revalidateOnFocus off
 * for the same reason. `refresh()` for a manual recheck.
 */
export function usePreflight() {
  const { data, error, isLoading, mutate } = useSWR<PreflightReport>(
    "/api/preflight",
    fetcher,
    { refreshInterval: 300_000, revalidateOnFocus: false },
  )
  return { report: data, error, isLoading, refresh: mutate }
}
