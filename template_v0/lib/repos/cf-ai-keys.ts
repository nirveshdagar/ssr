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

let schemaReady = false

export function ensureCfAiKeysSchema(): void {
  if (schemaReady) return
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS cf_workers_ai_keys (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id      TEXT NOT NULL,
      api_token       TEXT NOT NULL,
      alias           TEXT,
      is_active       INTEGER NOT NULL DEFAULT 1,
      calls_today     INTEGER NOT NULL DEFAULT 0,
      calls_total     INTEGER NOT NULL DEFAULT 0,
      last_call_at    TEXT,
      last_call_date  TEXT,
      last_error      TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      UNIQUE(account_id, api_token)
    );
  `)
  schemaReady = true
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

const PUBLIC_COLS =
  "id, account_id, alias, is_active, calls_today, calls_total, " +
  "last_call_at, last_error, created_at, " +
  "substr(account_id, 1, 6) || '...' || substr(account_id, length(account_id) - 3) AS account_id_preview, " +
  "substr(api_token, 1, 6) || '...' || substr(api_token, length(api_token) - 3) AS token_preview"

export function listCfAiKeysWithPreview(): CfAiKeyWithPreview[] {
  ensureCfAiKeysSchema()
  return all<CfAiKeyWithPreview>(
    `SELECT ${PUBLIC_COLS} FROM cf_workers_ai_keys ORDER BY id ASC`,
  )
}

export function getCfAiKey(id: number): CfAiKeyRow | undefined {
  ensureCfAiKeysSchema()
  return one<CfAiKeyRow>("SELECT * FROM cf_workers_ai_keys WHERE id = ?", id)
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
  const dup = one<{ id: number }>(
    "SELECT id FROM cf_workers_ai_keys WHERE account_id = ? AND api_token = ?",
    opts.accountId, opts.apiToken,
  )
  if (dup) {
    throw new Error(`This (account_id, token) pair is already in the pool (id=${dup.id})`)
  }
  const res = run(
    `INSERT INTO cf_workers_ai_keys(account_id, api_token, alias)
     VALUES(?, ?, ?)`,
    opts.accountId, opts.apiToken, opts.alias ?? null,
  )
  return Number(res.lastInsertRowid)
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
