/**
 * Cloudflare Workers AI key pool — separate from cf_keys (DNS) because the
 * lifecycle is different: AI tokens are scoped to Workers AI only, rotation
 * is by least-recently-called, and there's no per-key domain assignment.
 *
 * Each row = one CF account that's contributing its 10 000-neuron/day free
 * tier to the LLM pool. Active rows are round-robin'd by `cf-ai-pool.ts`.
 *
 * Schema is self-bootstrapped (CREATE TABLE IF NOT EXISTS) so this v8-only
 * feature doesn't depend on Flask's init_db running first. The Flask side
 * never reads or writes this table.
 */
import { all, getDb, one, run } from "../db"
import { decrypt, encrypt } from "../secrets-vault"

/**
 * Schema for cf_workers_ai_keys is now created in lib/init-schema.ts on
 * first connection. This function is kept as a no-op alias so existing
 * callers don't have to be updated all at once. Will be removed in a
 * future cleanup pass.
 */
export function ensureCfAiKeysSchema(): void {
  // Schema is created in lib/init-schema.ts during getDb().
  // Calling getDb() here would only force-init it if for some reason a
  // caller bypassed db.ts — defensive, cheap.
  getDb()
}

export interface CfAiKeyRow {
  id: number
  account_id: string
  api_token: string
  alias: string | null
  is_active: number
  calls_today: number
  calls_total: number
  last_call_at: string | null
  last_call_date: string | null
  last_error: string | null
  created_at: string
}

export interface CfAiKeyWithPreview {
  id: number
  account_id: string
  alias: string | null
  is_active: number
  calls_today: number
  calls_total: number
  last_call_at: string | null
  last_error: string | null
  created_at: string
  account_id_preview: string
  token_preview: string
}

/**
 * Build a "abcd12...wxyz" preview of a credential. The api_token column is
 * encrypted at rest (Fernet); SQL-level substr would show the ciphertext
 * prefix, which is useless to the operator. Compute previews in JS after
 * decrypt() so the operator sees the actual plaintext head/tail bytes.
 */
function previewCredential(plain: string): string {
  if (!plain) return ""
  if (plain.length <= 12) return plain.slice(0, 3) + "..." + plain.slice(-2)
  return plain.slice(0, 6) + "..." + plain.slice(-3)
}

const RAW_COLS = "id, account_id, alias, is_active, calls_today, calls_total, last_call_at, last_error, created_at, api_token"

interface RawPreviewRow {
  id: number
  account_id: string
  alias: string | null
  is_active: number
  calls_today: number
  calls_total: number
  last_call_at: string | null
  last_error: string | null
  created_at: string
  api_token: string
}

export function listCfAiKeysWithPreview(): CfAiKeyWithPreview[] {
  ensureCfAiKeysSchema()
  const rows = all<RawPreviewRow>(
    `SELECT ${RAW_COLS} FROM cf_workers_ai_keys ORDER BY id ASC`,
  )
  return rows.map((r) => {
    const plainToken = decrypt(r.api_token)
    return {
      id: r.id,
      account_id: r.account_id,
      alias: r.alias,
      is_active: r.is_active,
      calls_today: r.calls_today,
      calls_total: r.calls_total,
      last_call_at: r.last_call_at,
      last_error: r.last_error,
      created_at: r.created_at,
      account_id_preview: previewCredential(r.account_id),
      token_preview: previewCredential(plainToken),
    }
  })
}

export function getCfAiKey(id: number): CfAiKeyRow | undefined {
  ensureCfAiKeysSchema()
  const row = one<CfAiKeyRow>("SELECT * FROM cf_workers_ai_keys WHERE id = ?", id)
  if (!row) return undefined
  return { ...row, api_token: decrypt(row.api_token) }
}

/** Insert. Returns the new row id. Throws on duplicate (account_id, token). */
export function addCfAiKey(opts: {
  accountId: string
  apiToken: string
  alias?: string | null
}): number {
  ensureCfAiKeysSchema()
  if (!opts.accountId || !opts.apiToken) {
    throw new Error("account_id and api_token are required")
  }
  // Dup-check by decrypting existing rows for the same account_id. SQL
  // equality on encrypted text doesn't work because each encrypt() call
  // generates a fresh IV → different ciphertext for the same plaintext.
  const existing = all<{ id: number; api_token: string }>(
    "SELECT id, api_token FROM cf_workers_ai_keys WHERE account_id = ?",
    opts.accountId,
  )
  for (const r of existing) {
    if (decrypt(r.api_token) === opts.apiToken) {
      throw new Error(`This (account_id, token) pair is already in the pool (id=${r.id})`)
    }
  }
  const res = run(
    `INSERT INTO cf_workers_ai_keys(account_id, api_token, alias)
     VALUES(?, ?, ?)`,
    opts.accountId, encrypt(opts.apiToken), opts.alias ?? null,
  )
  return Number(res.lastInsertRowid)
}

/**
 * One-shot boot migration: re-encrypt any plaintext rows. The decrypt()
 * helper is a no-op for unmarked legacy values, so plaintext rows survive
 * read-paths until this sweep replaces them. Idempotent — already-encrypted
 * rows are skipped.
 */
export function encryptExistingAiTokens(): { converted: number; skipped: number } {
  ensureCfAiKeysSchema()
  const rows = all<{ id: number; api_token: string }>(
    "SELECT id, api_token FROM cf_workers_ai_keys",
  )
  let converted = 0
  let skipped = 0
  for (const r of rows) {
    if (r.api_token.startsWith("enc:v1:")) { skipped++; continue }
    if (!r.api_token) { skipped++; continue }
    run(
      "UPDATE cf_workers_ai_keys SET api_token = ? WHERE id = ?",
      encrypt(r.api_token), r.id,
    )
    converted++
  }
  return { converted, skipped }
}

export function toggleCfAiKeyActive(id: number): boolean {
  ensureCfAiKeysSchema()
  const row = one<{ is_active: number }>(
    "SELECT is_active FROM cf_workers_ai_keys WHERE id = ?", id,
  )
  if (!row) return false
  run("UPDATE cf_workers_ai_keys SET is_active = ? WHERE id = ?", row.is_active ? 0 : 1, id)
  return true
}

export function editCfAiKeyAlias(id: number, alias: string | null): void {
  ensureCfAiKeysSchema()
  run("UPDATE cf_workers_ai_keys SET alias = ? WHERE id = ?", alias, id)
}

export function deleteCfAiKey(id: number): void {
  ensureCfAiKeysSchema()
  run("DELETE FROM cf_workers_ai_keys WHERE id = ?", id)
}
