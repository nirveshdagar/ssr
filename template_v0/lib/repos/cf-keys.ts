import { all, getDb, one, run } from "../db"
import { decrypt, encrypt } from "../secrets-vault"

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
  last_error: string | null
  last_error_at: string | null
}

export interface CfKeyWithPreview extends CfKeyRow {
  key_preview: string
  domains_count: number
}

/**
 * Build a "abc123...wxyz" preview of a credential. The api_key column is
 * encrypted at rest (Fernet); SQL-level substr would show the ciphertext
 * prefix, which is useless to the operator. Compute previews in JS after
 * decrypt() so the operator sees real plaintext head/tail bytes.
 */
function previewCredential(plain: string): string {
  if (!plain) return ""
  if (plain.length <= 12) return plain.slice(0, 3) + "..." + plain.slice(-2)
  return plain.slice(0, 6) + "..." + plain.slice(-3)
}

interface RawPreviewRow {
  id: number
  email: string
  alias: string | null
  cf_account_id: string | null
  domains_used: number
  max_domains: number
  is_active: number
  created_at: string
  last_used_at: string | null
  last_error: string | null
  last_error_at: string | null
  api_key: string
  domains_count: number
}

export function listCfKeysWithPreview(): CfKeyWithPreview[] {
  const rows = all<RawPreviewRow>(`
    SELECT k.id, k.email, k.alias, k.cf_account_id,
           k.domains_used, k.max_domains, k.is_active,
           k.created_at, k.last_used_at, k.last_error, k.last_error_at, k.api_key,
           (SELECT COUNT(*) FROM domains d WHERE d.cf_key_id = k.id) AS domains_count
      FROM cf_keys k
     ORDER BY k.id ASC
  `)
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    alias: r.alias,
    cf_account_id: r.cf_account_id,
    domains_used: r.domains_used,
    max_domains: r.max_domains,
    is_active: r.is_active,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    last_error: r.last_error,
    last_error_at: r.last_error_at,
    domains_count: r.domains_count,
    key_preview: previewCredential(decrypt(r.api_key)),
  }))
}

export function getCfKey(id: number): CfKeyRow | undefined {
  return one<CfKeyRow>("SELECT * FROM cf_keys WHERE id = ?", id)
}

/**
 * One-shot boot migration: re-encrypt any plaintext api_key rows. The
 * decrypt() helper is a no-op for unmarked legacy values, so plaintext rows
 * keep working on read paths until this sweep replaces them. Idempotent —
 * already-encrypted rows are skipped.
 */
export function encryptExistingCfKeys(): { converted: number; skipped: number } {
  const rows = all<{ id: number; api_key: string }>("SELECT id, api_key FROM cf_keys")
  let converted = 0
  let skipped = 0
  for (const r of rows) {
    if (!r.api_key) { skipped++; continue }
    if (r.api_key.startsWith("enc:v1:")) { skipped++; continue }
    run("UPDATE cf_keys SET api_key = ? WHERE id = ?", encrypt(r.api_key), r.id)
    converted++
  }
  return { converted, skipped }
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
  // Wrap reference-check + DELETE in BEGIN IMMEDIATE so a pipeline.full
  // running between the SELECT and the DELETE can't slip a new domain row
  // pointing at this key in. Without the transaction the DELETE succeeds
  // and the new row holds a dangling FK.
  const db = getDb()
  db.exec("BEGIN IMMEDIATE")
  try {
    const ref = db.prepare("SELECT COUNT(*) AS n FROM domains WHERE cf_key_id = ?").get(id) as { n: number } | undefined
    if (ref && ref.n > 0) {
      db.exec("ROLLBACK")
      return { ok: false, reason: `${ref.n} domain(s) still reference this key` }
    }
    db.prepare("DELETE FROM cf_keys WHERE id = ?").run(id)
    db.exec("COMMIT")
    return { ok: true }
  } catch (e) {
    try { db.exec("ROLLBACK") } catch { /* ignore */ }
    throw e
  }
}

export function editCfKey(id: number, alias: string | null, max_domains: number): void {
  run(
    "UPDATE cf_keys SET alias = ?, max_domains = ? WHERE id = ?",
    alias,
    max_domains,
    id,
  )
}

/**
 * Set last_error + last_error_at on a CF key row. Pass null to clear.
 * Truncates msg to 500 chars to keep the column tame for grids.
 */
export function setCfKeyLastError(id: number, msg: string | null): void {
  if (msg === null) {
    run("UPDATE cf_keys SET last_error = NULL, last_error_at = NULL WHERE id = ?", id)
    return
  }
  const trimmed = msg.length > 500 ? msg.slice(0, 497) + "..." : msg
  run(
    "UPDATE cf_keys SET last_error = ?, last_error_at = datetime('now') WHERE id = ?",
    trimmed,
    id,
  )
}

/**
 * Bulk update fields on a set of CF key ids. Returns count updated.
 *
 * For alias_pattern, the caller has already substituted {n} placeholders so
 * we receive parallel arrays (ids[i] gets aliases[i]). Per-row in a single
 * IMMEDIATE transaction so a partial failure doesn't leave half-applied
 * pattern aliases.
 */
export function bulkEditCfKeys(opts: {
  ids: number[]
  alias?: (string | null)[]
  max_domains?: number
  is_active?: 0 | 1
}): { updated: number; missing: number[] } {
  const { ids, alias, max_domains, is_active } = opts
  if (ids.length === 0) return { updated: 0, missing: [] }
  if (alias && alias.length !== ids.length) {
    throw new Error("bulkEditCfKeys: alias[] length must match ids[] length")
  }

  const db = getDb()
  db.exec("BEGIN IMMEDIATE")
  try {
    const exists = db.prepare("SELECT 1 FROM cf_keys WHERE id = ?")
    const upAlias = db.prepare("UPDATE cf_keys SET alias = ? WHERE id = ?")
    const upMax = db.prepare("UPDATE cf_keys SET max_domains = ? WHERE id = ?")
    const upActive = db.prepare("UPDATE cf_keys SET is_active = ? WHERE id = ?")

    let updated = 0
    const missing: number[] = []
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      if (!exists.get(id)) { missing.push(id); continue }
      if (alias) upAlias.run(alias[i], id)
      if (max_domains !== undefined) upMax.run(max_domains, id)
      if (is_active !== undefined) upActive.run(is_active, id)
      updated++
    }
    db.exec("COMMIT")
    return { updated, missing }
  } catch (e) {
    try { db.exec("ROLLBACK") } catch { /* ignore */ }
    throw e
  }
}

/**
 * Substitute {n} or {n:0K} placeholders in `pattern` with `start + i`. Used
 * by bulk-rename so the operator can apply "CF-{n:03}" across N selected
 * rows and get CF-001, CF-002, ...
 */
export function applyAliasPattern(pattern: string, count: number, start = 1): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const n = start + i
    out.push(
      pattern.replace(/\{n(?::0(\d+))?\}/g, (_m, padRaw) => {
        const pad = padRaw ? Number.parseInt(padRaw, 10) : 0
        return pad > 0 ? String(n).padStart(pad, "0") : String(n)
      }),
    )
  }
  return out
}

/** Existence check + dedup helper for bulk-add pre-flight. */
export function findExistingEmails(emails: string[]): Set<string> {
  if (emails.length === 0) return new Set()
  const placeholders = emails.map(() => "?").join(",")
  const rows = all<{ email: string }>(
    `SELECT email FROM cf_keys WHERE email IN (${placeholders})`,
    ...emails,
  )
  return new Set(rows.map((r) => r.email))
}
