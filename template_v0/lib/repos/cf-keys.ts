import { all, one, run } from "../db"
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
  api_key: string
  domains_count: number
}

export function listCfKeysWithPreview(): CfKeyWithPreview[] {
  const rows = all<RawPreviewRow>(`
    SELECT k.id, k.email, k.alias, k.cf_account_id,
           k.domains_used, k.max_domains, k.is_active,
           k.created_at, k.last_used_at, k.api_key,
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
