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
  /** 1 = operator dismissed this domain from the /watcher list (UI-only;
   *  orthogonal to status). Reset to 0 on pipeline run teardown. */
  watcher_dismissed: number | null
  last_heartbeat_at: string | null
  /** 1 = CF Origin Cert verified on the wire, 0 = wrong cert, NULL = unknown */
  ssl_origin_ok: number | null
  ssl_last_verified_at: string | null
  /** 1 = HTTPS probe 2xx/3xx, 0 = failure, NULL = never probed */
  live_ok: number | null
  live_reason: string | null
  live_http_status: number | null
  live_checked_at: string | null
  /** 1 = response body is real content, 0 = SA welcome / Apache default,
   *  NULL = unknown */
  content_ok: number | null
  content_checked_at: string | null
  created_at: string
  updated_at: string
}

const DOMAIN_COLS = new Set<keyof DomainRow>([
  "status", "cf_email", "cf_global_key", "cf_zone_id", "cf_nameservers",
  "cf_account_id", "server_id", "current_proxy_ip", "site_html",
  "cf_a_record_id", "cf_www_record_id", "origin_cert_pem", "origin_key_pem",
  "content_archive_path", "cancel_requested", "watcher_dismissed",
  "ssl_origin_ok", "ssl_last_verified_at",
  "live_ok", "live_reason", "live_http_status", "live_checked_at",
  "content_ok", "content_checked_at",
])

export function listDomains(): DomainRow[] {
  return all<DomainRow>("SELECT * FROM domains ORDER BY id DESC")
}

export function getDomain(domain: string): DomainRow | undefined {
  return one<DomainRow>("SELECT * FROM domains WHERE domain = ?", domain)
}

export function addDomain(domain: string): void {
  // Gap-filling id allocation (operator preference 2026-05-14): mirror of
  // addServer's strategy — pick the lowest unused id ≥ 1 so deletes free
  // up their slot for reuse. INSERT OR IGNORE preserved: if `domain`
  // already exists (UNIQUE on the name), no row is inserted and the
  // computed id stays available for the next caller. See addServer for
  // the audit-trail trade-off note.
  const db = getDb()
  db.exec("BEGIN IMMEDIATE")
  try {
    // If the domain already exists, exit early — don't burn a free id slot.
    const exists = db.prepare("SELECT 1 FROM domains WHERE domain = ?").get(domain)
    if (exists) { db.exec("COMMIT"); return }
    const used = db.prepare("SELECT id FROM domains ORDER BY id").all() as { id: number }[]
    let nextId = 1
    for (const row of used) {
      if (row.id === nextId) nextId++
      else if (row.id > nextId) break
    }
    db.prepare("INSERT INTO domains (id, domain) VALUES (?, ?)").run(nextId, domain)
    db.exec("COMMIT")
  } catch (e) {
    try { db.exec("ROLLBACK") } catch { /* ignore */ }
    throw e
  }
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
  // Atomically drop the domain row AND its step_tracker rows. Without the
  // step_tracker cleanup, re-adding the same domain name later inherits the
  // prior incarnation's "completed/skipped" step locks (initSteps uses
  // INSERT...ON CONFLICT that preserves completed rows), and the next
  // pipeline run skips every step that was once completed — even though
  // the corresponding CF zone / SA app / droplet are long gone. pipeline_log
  // and pipeline_runs are deliberately KEPT for historical audit; only the
  // lock-source table is reset.
  const db = getDb()
  db.exec("BEGIN IMMEDIATE")
  try {
    db.prepare("DELETE FROM step_tracker WHERE domain = ?").run(domain)
    db.prepare("DELETE FROM domains WHERE domain = ?").run(domain)
    db.exec("COMMIT")
  } catch (e) {
    try { db.exec("ROLLBACK") } catch { /* ignore */ }
    throw e
  }
  // Best-effort archive cleanup. Fire-and-forget dynamic import to dodge the
  // migration.ts → repos/domains.ts cycle. Without this, every soft-delete
  // path (bare DELETE, bulk-delete, sync-from-SA, server db-delete) leaks the
  // local site_archives/<domain>.tar.gz forever — only the "Full Delete"
  // teardown handler cleans it up otherwise.
  void import("../migration").then(({ deleteArchive }) => {
    try { deleteArchive(domain) } catch { /* deleteArchive already logs */ }
  }).catch(() => { /* import failure is harmless — archive will be swept */ })
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
