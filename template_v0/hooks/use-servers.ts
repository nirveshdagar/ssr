"use client"

import useSWR from "swr"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export interface ServerRow {
  id: string
  name: string
  region: string
  ip: string
  size: string
  domains: number
  capacity: number
  status: "active" | "dead" | "migrating" | "provisioning"
  createdAt: string
  /** DigitalOcean droplet id — needed by the destroy modal so the operator can
   *  cross-check the row in the DO console before a hard-delete. */
  doDropletId: string
  /** ServerAvatar server id — same purpose for the SA org. */
  saServerId: string
}

interface ApiServer {
  id: number
  name: string | null
  ip: string | null
  region: string | null
  size_slug: string | null
  status: string
  max_sites: number
  sites_count: number
  created_at: string
  do_droplet_id: string | null
  sa_server_id: string | null
}

const STATUS_MAP: Record<string, ServerRow["status"]> = {
  ready: "active",
  active: "active",
  dead: "dead",
  migrating: "migrating",
  pending: "provisioning",
  provisioning: "provisioning",
  detected: "active",
}

export function useServers() {
  const { data, error, isLoading, mutate } = useSWR<{ servers: ApiServer[] }>(
    "/api/servers",
    fetcher,
    { refreshInterval: 5000 },
  )
  const rows: ServerRow[] = (data?.servers ?? []).map((s) => ({
    id: String(s.id),
    name: s.name ?? `srv-${s.id}`,
    region: s.region ?? "—",
    ip: s.ip ?? "—",
    size: s.size_slug ?? "—",
    domains: s.sites_count ?? 0,
    capacity: s.max_sites ?? 60,
    status: STATUS_MAP[s.status] ?? "active",
    createdAt: s.created_at,
    doDropletId: s.do_droplet_id ?? "",
    saServerId: s.sa_server_id ?? "",
  }))
  return { rows, error, isLoading, refresh: mutate }
}
