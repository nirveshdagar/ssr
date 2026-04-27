import { all, one, run } from "../db"

export interface ServerRow {
  id: number
  name: string | null
  ip: string | null
  do_droplet_id: string | null
  sa_server_id: string | null
  sa_org_id: string | null
  status: string
  region: string | null
  size_slug: string | null
  max_sites: number
  sites_count: number
  created_at: string
}

const SERVER_COLS = new Set<keyof ServerRow>([
  "name", "ip", "do_droplet_id", "sa_server_id", "sa_org_id", "status",
  "region", "size_slug", "max_sites",
])

export function listServers(): ServerRow[] {
  // sites_count computed on read — matches the Flask side's get_servers().
  return all<ServerRow>(`
    SELECT s.*,
           (SELECT COUNT(*) FROM domains d WHERE d.server_id = s.id) AS sites_count
      FROM servers s
     ORDER BY s.id DESC
  `)
}

export function getServer(id: number): ServerRow | undefined {
  return one<ServerRow>(`
    SELECT s.*,
           (SELECT COUNT(*) FROM domains d WHERE d.server_id = s.id) AS sites_count
      FROM servers s
     WHERE s.id = ?
  `, id)
}

export function updateServer(id: number, updates: Partial<ServerRow>): void {
  const entries = Object.entries(updates).filter(([k]) => SERVER_COLS.has(k as keyof ServerRow))
  if (entries.length === 0) return
  const setClause = entries.map(([k]) => `${k} = ?`).join(", ")
  const values = entries.map(([, v]) => v as string | number | null)
  run(`UPDATE servers SET ${setClause} WHERE id = ?`, ...values, id)
}

export function deleteServerRow(id: number): void {
  run("DELETE FROM servers WHERE id = ?", id)
}

export function addServer(name: string, ip: string, doDropletId?: string | null): number {
  const r = run(
    `INSERT INTO servers(name, ip, do_droplet_id, status) VALUES(?, ?, ?, 'creating')`,
    name, ip, doDropletId ?? null,
  )
  return Number(r.lastInsertRowid)
}

export function countDomainsOnServer(serverId: number): number {
  const row = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM domains WHERE server_id = ?",
    serverId,
  )
  return row?.n ?? 0
}
