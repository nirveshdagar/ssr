/**
 * Cloudflare API key pool — Node port of modules/cf_key_pool.py.
 *
 * Each CF key holds a fixed number of zones (default 20). Domains take a
 * "slot" from the next available key. When all keys are at max_domains,
 * `getNextAvailableCfKey()` throws CFKeyPoolExhausted — the pipeline pauses
 * and the operator must add a new key from the dashboard.
 *
 * Slot accounting matches the Python module exactly. `releaseCfKeySlot`
 * re-exports from repos/domains.ts so a single implementation remains
 * authoritative when domains are deleted.
 *
 * DB-only: this module never calls Cloudflare HTTP except in
 * `refreshCfAccountId` (which fetches /accounts to repair a stale stored ID).
 */

import { getDb, all, one, run } from "./db"
import { getSetting } from "./repos/settings"
import { decrypt, encrypt } from "./secrets-vault"
export { releaseCfKeySlot } from "./repos/domains"

export class CFKeyPoolExhausted extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CFKeyPoolExhausted"
  }
}

export interface CfKeyWithCreds {
  id: number
  email: string
  api_key: string
  alias: string | null
  cf_account_id: string | null
  domains_used: number
  max_domains: number
}

export interface CfKeyPublic {
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

const KEY_WITH_CREDS_COLS =
  "id, email, api_key, alias, cf_account_id, domains_used, max_domains"

const KEY_PUBLIC_COLS =
  "id, email, alias, cf_account_id, domains_used, max_domains, " +
  "is_active, created_at, last_used_at"

// ---------------------------------------------------------------------------
// Pool selection
// ---------------------------------------------------------------------------

export function getNextAvailableCfKey(): CfKeyWithCreds {
  const row = one<CfKeyWithCreds>(
    `SELECT ${KEY_WITH_CREDS_COLS}
       FROM cf_keys
      WHERE is_active = 1 AND domains_used < max_domains
      ORDER BY id ASC
      LIMIT 1`,
  )
  if (row) return { ...row, api_key: decrypt(row.api_key) }
  const total = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM cf_keys WHERE is_active = 1",
  )?.n ?? 0
  if (total === 0) {
    throw new CFKeyPoolExhausted("No active CF keys in pool. Add one via the dashboard.")
  }
  throw new CFKeyPoolExhausted(
    `All ${total} CF keys are at max_domains. Add a new key to continue.`,
  )
}

// ---------------------------------------------------------------------------
// Atomic assignment with race-safe increment
// ---------------------------------------------------------------------------

/**
 * Pick (or reuse) a CF key for `domain` and increment usage atomically.
 * Idempotent: if the domain already has cf_key_id set, returns the existing
 * key without mutating the counter.
 *
 * `keyId` forces a specific key (the operator may want to override the
 * round-robin pick). If that key has no capacity / is inactive, throws.
 */
export function assignCfKeyToDomain(domain: string, keyId?: number): CfKeyWithCreds {
  // 1. Fast path: domain already has a key — return without touching counters
  const existing = one<{ cf_key_id: number | null }>(
    "SELECT cf_key_id FROM domains WHERE domain = ?",
    domain,
  )
  if (existing?.cf_key_id) {
    const keyRow = one<CfKeyWithCreds>(
      `SELECT ${KEY_WITH_CREDS_COLS} FROM cf_keys WHERE id = ?`,
      existing.cf_key_id,
    )
    if (keyRow) return { ...keyRow, api_key: decrypt(keyRow.api_key) }
  }

  // 2. Pick a candidate
  let candidate: CfKeyWithCreds
  if (keyId == null) {
    candidate = getNextAvailableCfKey()
  } else {
    const row = one<CfKeyWithCreds>(
      `SELECT ${KEY_WITH_CREDS_COLS} FROM cf_keys
        WHERE id = ? AND is_active = 1 AND domains_used < max_domains`,
      keyId,
    )
    if (!row) {
      throw new CFKeyPoolExhausted(
        `CF key id=${keyId} not available (missing, inactive, or full).`,
      )
    }
    candidate = { ...row, api_key: decrypt(row.api_key) }
  }

  // 3. Atomic increment + assignment.
  // node:sqlite doesn't expose a Transaction helper — use raw BEGIN/COMMIT.
  const db = getDb()
  db.exec("BEGIN IMMEDIATE")
  try {
    const incRes = db
      .prepare(
        `UPDATE cf_keys
            SET domains_used = domains_used + 1,
                last_used_at = datetime('now')
          WHERE id = ?
            AND domains_used < max_domains
            AND is_active = 1`,
      )
      .run(candidate.id)
    if (incRes.changes !== 1) {
      // Race: someone filled the slot between SELECT and UPDATE. Roll back
      // and retry with a fresh pick (no keyId override — the override is the
      // operator's "use this one specifically" choice, but if it's full we
      // have to fall back to the next free one).
      db.exec("ROLLBACK")
      return assignCfKeyToDomain(domain) // retry with auto-pick
    }
    db.prepare(
      `UPDATE domains
          SET cf_key_id = ?,
              cf_email = ?,
              cf_global_key = ?,
              cf_account_id = ?,
              updated_at = datetime('now')
        WHERE domain = ?`,
    ).run(
      candidate.id,
      candidate.email,
      candidate.api_key,
      candidate.cf_account_id,
      domain,
    )
    db.exec("COMMIT")
  } catch (e) {
    try { db.exec("ROLLBACK") } catch { /* ignore */ }
    throw e
  }

  // 4. Return fresh row (so the caller sees the post-increment domains_used)
  const fresh = one<CfKeyWithCreds>(
    `SELECT ${KEY_WITH_CREDS_COLS} FROM cf_keys WHERE id = ?`,
    candidate.id,
  )!
  return { ...fresh, api_key: decrypt(fresh.api_key) }
}

// ---------------------------------------------------------------------------
// Listing + maintenance
// ---------------------------------------------------------------------------

export function listCfKeys(): CfKeyPublic[] {
  return all<CfKeyPublic>(
    `SELECT ${KEY_PUBLIC_COLS} FROM cf_keys ORDER BY id ASC`,
  )
}

/** Insert a new CF key into the pool. Returns the inserted row id.
 *  Throws if email already exists. */
export function addCfKey(opts: {
  email: string
  apiKey: string
  alias?: string | null
  cfAccountId?: string | null
  maxDomains?: number | null
}): number {
  if (!opts.email || !opts.apiKey) {
    throw new Error("email and api_key are required")
  }
  let maxDomains = opts.maxDomains
  if (maxDomains == null) {
    const fromSetting = parseInt(getSetting("cf_domains_per_key") || "20", 10)
    maxDomains = Number.isFinite(fromSetting) && fromSetting > 0 ? fromSetting : 20
  }

  const dup = one<{ id: number }>(
    "SELECT id FROM cf_keys WHERE email = ?",
    opts.email,
  )
  if (dup) {
    throw new Error(`CF key for email ${opts.email} already exists (id=${dup.id})`)
  }
  const res = run(
    `INSERT INTO cf_keys(email, api_key, alias, cf_account_id, max_domains)
     VALUES(?, ?, ?, ?, ?)`,
    opts.email,
    encrypt(opts.apiKey),
    opts.alias ?? null,
    opts.cfAccountId ?? null,
    maxDomains,
  )
  return Number(res.lastInsertRowid)
}

// ---------------------------------------------------------------------------
// Account ID refresh — re-fetches CF /accounts and persists the real id
// ---------------------------------------------------------------------------

interface RefreshResult {
  id: number
  email: string
  alias: string | null
  before: string
  after: string
  changed: boolean
  error: string | null
}

/**
 * Re-fetch the real Account ID from Cloudflare's /accounts endpoint and
 * store it on this cf_keys row AND on every domain assigned to the key.
 * Used when a stored account_id is stale (e.g. older code wrote the user
 * id into cf_account_id by mistake).
 */
export async function refreshCfAccountId(cfKeyId: number): Promise<string> {
  const row = one<{ id: number; email: string; api_key: string }>(
    "SELECT id, email, api_key FROM cf_keys WHERE id = ?",
    cfKeyId,
  )
  if (!row) throw new Error(`cf_keys id=${cfKeyId} not found`)
  const apiKey = decrypt(row.api_key)

  const res = await fetch("https://api.cloudflare.com/client/v4/accounts", {
    headers: {
      "X-Auth-Email": row.email,
      "X-Auth-Key": apiKey,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`CF /accounts HTTP ${res.status}: ${body.slice(0, 300)}`)
  }
  const json = (await res.json()) as { result?: { id?: string }[] }
  const accts = json.result ?? []
  if (accts.length === 0) {
    throw new Error(
      `CF returned no accounts for ${row.email} — is billing set up on this CF account?`,
    )
  }
  const realId = accts[0].id
  if (!realId) throw new Error(`CF /accounts response missing id: ${JSON.stringify(accts[0])}`)

  run("UPDATE cf_keys SET cf_account_id = ? WHERE id = ?", realId, cfKeyId)
  run("UPDATE domains  SET cf_account_id = ? WHERE cf_key_id = ?", realId, cfKeyId)
  return realId
}

/** Refresh every active key's account_id. Returns one result per key. */
export async function refreshAllCfAccountIds(): Promise<RefreshResult[]> {
  const out: RefreshResult[] = []
  for (const k of listCfKeys()) {
    const before = k.cf_account_id ?? ""
    try {
      const after = await refreshCfAccountId(k.id)
      out.push({
        id: k.id, email: k.email, alias: k.alias,
        before, after, changed: before !== after, error: null,
      })
    } catch (e) {
      out.push({
        id: k.id, email: k.email, alias: k.alias,
        before, after: before, changed: false, error: (e as Error).message,
      })
    }
  }
  return out
}
