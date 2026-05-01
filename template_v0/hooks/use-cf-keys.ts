"use client"

import useSWR from "swr"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export interface CfKeyRow {
  id: string
  /** Operator-facing label — alias if set, else email. */
  label: string
  /** Raw alias from DB (may be empty). Use this for the edit dialog. */
  alias: string
  email: string
  /** Masked api_key (first 6 + ... + last 4), computed in SQL. */
  keyPreview: string
  /** Full cf_account_id. */
  accountId: string
  /** First 10 chars of cf_account_id, truncated for display in the table. */
  accountIdShort: string
  /** domains_used — pool slot count, used for the X/Y display. */
  domains: number
  /** Hard cap from DB. */
  maxDomains: number
  /** is_active flag from DB (1 = active, 0 = paused). */
  isActive: boolean
  rateLimitUsed: number
  status: "healthy" | "warning" | "exhausted" | "paused"
  lastUsed: string
  /** Most recent CF API failure persisted on the row, or "" if none. */
  lastError: string
  /** ISO timestamp the last_error was recorded, or "" if none. */
  lastErrorAt: string
}

export interface CfKeyDomain {
  domain: string
  status: string
  current_proxy_ip: string | null
}

interface ApiCfKey {
  id: number
  email: string
  alias: string | null
  cf_account_id: string | null
  domains_used: number
  max_domains: number
  is_active: number
  last_used_at: string | null
  last_error: string | null
  last_error_at: string | null
  key_preview: string
  domains_count: number
}

function deriveStatus(used: number, cap: number, active: number): CfKeyRow["status"] {
  if (!active) return "paused"
  const pct = cap > 0 ? (used / cap) * 100 : 0
  if (pct >= 100) return "exhausted"
  if (pct >= 80) return "warning"
  return "healthy"
}

export function useCfKeys() {
  const { data, error, isLoading, mutate } = useSWR<{
    cf_keys: ApiCfKey[]
    domains_by_key: Record<number, CfKeyDomain[]>
  }>("/api/cf-keys", fetcher, { refreshInterval: 8000 })

  const rows: CfKeyRow[] = (data?.cf_keys ?? []).map((k) => ({
    id: String(k.id),
    label: k.alias || k.email,
    alias: k.alias ?? "",
    email: k.email,
    keyPreview: k.key_preview ?? "",
    accountId: k.cf_account_id ?? "",
    accountIdShort: k.cf_account_id ? `${k.cf_account_id.slice(0, 10)}…` : "—",
    domains: k.domains_used,
    maxDomains: k.max_domains,
    isActive: Boolean(k.is_active),
    rateLimitUsed: k.max_domains
      ? Math.min(100, Math.round((k.domains_used / k.max_domains) * 100))
      : 0,
    status: deriveStatus(k.domains_used, k.max_domains, k.is_active),
    lastUsed: k.last_used_at ?? "—",
    lastError: k.last_error ?? "",
    lastErrorAt: k.last_error_at ?? "",
  }))
  return {
    rows,
    domainsByKey: data?.domains_by_key ?? {},
    error,
    isLoading,
    refresh: mutate,
  }
}
