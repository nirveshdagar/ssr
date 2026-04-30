/**
 * Domain CRUD — mirrors the helpers in database.py + app.py.
 * Same column whitelist as Flask's _DOMAIN_COLS so a Next.js write
 * can never touch an unintended column.
 */
import { all, getDb, one, run } from "../db"

export interface DomainRow {
  id: number
  domain: string
  status: string
  cf_email: string | null
  cf_global_key: string | null
  cf_zone_id: string | null
  cf_nameservers: string | null
  cf_account_id: string | null
  cf_key_id: number | null
  server_id: number | null
  current_proxy_ip: string | null
  site_html: string | null
  cf_a_record_id: string | null
  cf_www_record_id: string | null
  origin_cert_pem: string | null
  origin_key_pem: string | null
  content_archive_path: string | null
  cancel_requested: number | null
  last_heartbeat_at: string | null
  /** 1 = CF Origin Cert verified on the wire, 0 = wrong cert, NULL = unknown */
  ssl_origin_ok: number | null
  ssl_last_verified_at: string | null
  /** 1 = HTTPS probe 2xx/3xx, 0 = failure, NULL = never probed */
  live_ok: number | null
  live_reason: string | null
  live_http_status: number | null
  live_checked_at: string | null
  created_at: string
  updated_at: string
}

const DOMAIN_COLS = new Set<keyof DomainRow>([
  "status", "cf_email", "cf_global_key", "cf_zone_id", "cf_nameservers",
  "cf_account_id", "server_id", "current_proxy_ip", "site_html",
  "cf_a_record_id", "cf_www_record_id", "origin_cert_pem", "origin_key_pem",
  "content_archive_path", "cancel_requested",
  "ssl_origin_ok", "ssl_last_verified_at",
  "live_ok", "live_reason", "live_http_status", "live_checked_at",
])

export function listDomains(): DomainRow[] {
  return all<DomainRow>("SELECT * FROM domains ORDER BY id DESC")
}

export function getDomain(domain: string): DomainRow | undefined {
  return one<DomainRow>("SELECT * FROM domains WHERE domain = ?", domain)
}

export function addDomain(domain: string): void {
  run("INSERT OR IGNORE INTO domains (domain) VALUES (?)", domain)
}

export function updateDomain(domain: string, updates: Partial<DomainRow>): void {
  const entries = Object.entries(updates).filter(([k]) => DOMAIN_COLS.has(k as keyof DomainRow))
  if (entries.length === 0) return
  const setClause = entries.map(([k]) => `${k} = ?`).join(", ")
  const values = entries.map(([, v]) => v as string | number | null)
  run(
    `UPDATE domains SET ${setClause}, updated_at = datetime('now') WHERE domain = ?`,
    ...values,
    domain,
  )
}

export function deleteDomain(domain: string): void {
  run("DELETE FROM domains WHERE domain = ?", domain)
}

export function releaseCfKeySlot(domain: string): void {
  // BEGIN IMMEDIATE so the decrement + domain-detach commit atomically.
  // Without the transaction, a crash between writes leaves the slot freed
  // but the domain still pointing at the key — a teardown retry would
  // then decrement again, drifting the counter under MAX(0, ...) bound.
  const db = getDb()
  db.exec("BEGIN IMMEDIATE")
  try {
    const row = db.prepare("SELECT cf_key_id FROM domains WHERE domain = ?").get(domain) as { cf_key_id: number | null } | undefined
    if (!row || !row.cf_key_id) {
      db.exec("ROLLBACK")
      return
    }
    db.prepare(
      "UPDATE cf_keys SET domains_used = MAX(0, domains_used - 1) WHERE id = ?",
    ).run(row.cf_key_id)
    db.prepare("UPDATE domains SET cf_key_id = NULL WHERE domain = ?").run(domain)
    db.exec("COMMIT")
  } catch (e) {
    try { db.exec("ROLLBACK") } catch { /* ignore */ }
    throw e
  }
}
