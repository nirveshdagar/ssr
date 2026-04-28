"use client"

import useSWR from "swr"
import type { PipelineStatus } from "@/lib/ssr/mock-data"

const fetcher = (url: string) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
})

/**
 * Shape the Domains page already expects (matches lib/ssr/mock-data.ts so the
 * existing JSX keeps working). We adapt the real DB rows here.
 */
export interface DomainRow {
  id: string
  name: string
  /** Normalized to PipelineStatus for badge/chip rendering. */
  status: PipelineStatus
  /** Raw DB status (e.g. "ns_pending_external", "ssl_installed") — exposed
   *  so the page can filter against the 22 fine-grained Flask statuses. */
  rawStatus: string
  step: number
  /** step_tracker.status of the current step ("running"/"completed"/"failed"/etc) */
  stepStatus: string | null
  /** Human-readable step name like "buy_domain" / "create_zone" */
  stepName: string | null
  /** Latest message from step_tracker for the current step — what's
   *  actually happening right now. Surfaced on the dashboard so the
   *  progress card isn't blank when a pipeline is mid-flight. */
  stepMessage: string | null
  server: string
  cfKey: string
  cfEmail: string
  cfZoneId: string
  cfGlobalKey: string
  serverId: number | null
  cfKeyId: number | null
  ip: string
  createdAt: string
  registrar: "Spaceship" | "Imported"
}

interface ApiDomain {
  id: number
  domain: string
  status: string
  server_id: number | null
  cf_key_id: number | null
  cf_email: string | null
  cf_global_key: string | null
  cf_zone_id: string | null
  current_proxy_ip: string | null
  created_at: string
  current_step: number
  current_step_status: string | null
  current_step_name: string | null
  current_step_message: string | null
}

const NORMALIZE_STATUS: Record<string, PipelineStatus> = {
  pending: "pending",
  purchased: "running",
  owned: "running",
  owned_external: "waiting",
  cf_assigned: "running",
  zone_created: "running",
  ns_set: "running",
  ns_pending_external: "waiting",
  zone_active: "running",
  app_created: "running",
  ssl_installed: "running",
  hosted: "completed",
  live: "live",
  canceled: "canceled",
  error: "retryable_error",
  retryable_error: "retryable_error",
  terminal_error: "terminal_error",
  content_blocked: "terminal_error",
  cf_pool_full: "terminal_error",
  manual_action_required: "waiting",
  waiting_dns: "waiting",
  ready_for_ssl: "running",
  ready_for_content: "running",
}

export function useDomains() {
  const { data, error, isLoading, mutate } = useSWR<{ domains: ApiDomain[] }>(
    "/api/domains",
    fetcher,
    { refreshInterval: 8000, revalidateOnFocus: false },
  )
  const rows: DomainRow[] = (data?.domains ?? []).map((d) => ({
    id: String(d.id),
    name: d.domain,
    status: NORMALIZE_STATUS[d.status] ?? "pending",
    rawStatus: d.status || "pending",
    step: d.current_step ?? 0,
    stepStatus: d.current_step_status ?? null,
    stepName: d.current_step_name ?? null,
    stepMessage: d.current_step_message ?? null,
    server: d.server_id ? `srv-${d.server_id}` : "—",
    cfKey: d.cf_key_id ? `cf-${d.cf_key_id}` : "—",
    cfEmail: d.cf_email ?? "",
    cfZoneId: d.cf_zone_id ?? "",
    cfGlobalKey: d.cf_global_key ?? "",
    serverId: d.server_id,
    cfKeyId: d.cf_key_id,
    ip: d.current_proxy_ip ?? "—",
    createdAt: d.created_at,
    registrar: "Spaceship",
  }))
  return { rows, error, isLoading, refresh: mutate }
}
