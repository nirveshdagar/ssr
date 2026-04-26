import { all, one, run } from "../db"

export interface CfKeyRow {
  id: number
  email: string
  alias: string | null
  cf_account_id: string | null
  domains_used: number
  max_domains: number
  is_active: number
  created_at: string
  last_used_at: string | null
}

export interface CfKeyWithPreview extends CfKeyRow {
  key_preview: string
  domains_count: number
}

/**
 * Match the cloudflare_page route in Flask: list keys with the masked
 * preview (first 6 + ... + last 4) computed in SQL so the full api_key
 * never leaves the database. Plus the count of domains using each key.
 */
export function listCfKeysWithPreview(): CfKeyWithPreview[] {
  return all<CfKeyWithPreview>(`
    SELECT k.id, k.email, k.alias, k.cf_account_id,
           k.domains_used, k.max_domains, k.is_active,
           k.created_at, k.last_used_at,
           substr(k.api_key, 1, 6) || '...' || substr(k.api_key, length(k.api_key) - 3) AS key_preview,
           (SELECT COUNT(*) FROM domains d WHERE d.cf_key_id = k.id) AS domains_count
      FROM cf_keys k
     ORDER BY k.id ASC
  `)
}

export function getCfKey(id: number): CfKeyRow | undefined {
  return one<CfKeyRow>("SELECT * FROM cf_keys WHERE id = ?", id)
}

export function listDomainsForKey(cfKeyId: number): {
  domain: string
  status: string
  current_proxy_ip: string | null
}[] {
  return all(
    `SELECT domain, status, current_proxy_ip
       FROM domains
      WHERE cf_key_id = ?
      ORDER BY domain`,
    cfKeyId,
  )
}

export function toggleCfKeyActive(id: number): boolean {
  const row = one<{ is_active: number }>("SELECT is_active FROM cf_keys WHERE id = ?", id)
  if (!row) return false
  run("UPDATE cf_keys SET is_active = ? WHERE id = ?", row.is_active ? 0 : 1, id)
  return true
}

export function deleteCfKey(id: number): { ok: boolean; reason?: string } {
  const ref = one<{ n: number }>("SELECT COUNT(*) AS n FROM domains WHERE cf_key_id = ?", id)
  if (ref && ref.n > 0) return { ok: false, reason: `${ref.n} domain(s) still reference this key` }
  run("DELETE FROM cf_keys WHERE id = ?", id)
  return { ok: true }
}

export function editCfKey(id: number, alias: string | null, max_domains: number): void {
  run(
    "UPDATE cf_keys SET alias = ?, max_domains = ? WHERE id = ?",
    alias,
    max_domains,
    id,
  )
}
