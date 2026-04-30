/**
 * Cloudflare Workers AI pool — round-robin over cf_workers_ai_keys so the
 * SSR LLM step-9 stacks the free 10k-neuron/day tier across every CF account
 * the operator has already provisioned (typically the same accounts in the
 * cf_keys DNS pool, but tracked separately because the scopes differ).
 *
 * Selection: pick the active row with the OLDEST last_call_at (NULL first),
 * which both spreads load evenly AND naturally prefers rows whose daily
 * window has reset (since we only mutate last_call_at on call, a row that
 * hasn't been touched in 24h+ surfaces first).
 *
 * `recordAiKeyCall` atomically increments calls_today (resetting to 1 when
 * last_call_date < today UTC), bumps calls_total, and stamps last_call_at.
 * `recordAiKeyError` stores last_error so the operator can see why a row
 * is failing in the UI.
 */
import { getDb, one } from "./db"
import { ensureCfAiKeysSchema } from "./repos/cf-ai-keys"
import { decrypt } from "./secrets-vault"

export class AiPoolExhausted extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AiPoolExhausted"
  }
}

export interface CfAiKeyWithCreds {
  id: number
  account_id: string
  api_token: string
  alias: string | null
  calls_today: number
  last_call_date: string | null
}

const CREDS_COLS = "id, account_id, api_token, alias, calls_today, last_call_date"

/**
 * Pick the next pool row to dispatch a call to AND atomically claim it
 * by stamping last_call_at = now. Without the atomic stamp, two parallel
 * step-9 runs entering at the same instant would both SELECT the LRU row
 * (the one with the oldest last_call_at), both fire requests at the same
 * CF account, and trip a 429 storm — defeating the whole point of having
 * multiple accounts in the pool.
 *
 * Strategy: BEGIN IMMEDIATE → SELECT the LRU row → UPDATE its last_call_at
 * to now → COMMIT. The next caller's SELECT now sees this row as recently-
 * called and picks the next-LRU instead.
 *
 * `excludeIds` lets the website-generator's retry loop skip a row that just
 * 429'd. Used during the same step 9 invocation.
 */
export function getNextAiKey(excludeIds: number[] = []): CfAiKeyWithCreds {
  ensureCfAiKeysSchema()
  const exclusion = excludeIds.length
    ? ` AND id NOT IN (${excludeIds.map(() => "?").join(",")})`
    : ""
  const db = getDb()
  db.exec("BEGIN IMMEDIATE")
  try {
    const row = db.prepare(
      `SELECT ${CREDS_COLS}
         FROM cf_workers_ai_keys
        WHERE is_active = 1${exclusion}
        ORDER BY (last_call_at IS NULL) DESC, last_call_at ASC, id ASC
        LIMIT 1`,
    ).get(...excludeIds) as CfAiKeyWithCreds | undefined
    if (row) {
      // Stamp last_call_at NOW so a concurrent caller's ORDER BY pushes
      // this row to the back of the line. Counters (calls_today,
      // calls_total) are still updated only by recordAiKeyCall after the
      // actual API call returns — that's the source of truth for usage.
      db.prepare(
        `UPDATE cf_workers_ai_keys SET last_call_at = datetime('now') WHERE id = ?`,
      ).run(row.id)
      db.exec("COMMIT")
      return { ...row, api_token: decrypt(row.api_token) }
    }
    db.exec("COMMIT")
  } catch (e) {
    try { db.exec("ROLLBACK") } catch { /* ignore */ }
    throw e
  }
  const total = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM cf_workers_ai_keys WHERE is_active = 1",
  )?.n ?? 0
  if (total === 0) {
    throw new AiPoolExhausted(
      "No active rows in the Cloudflare Workers AI pool. Add one in Settings → LLM.",
    )
  }
  throw new AiPoolExhausted(
    `All ${total} active pool rows have been tried this turn. ` +
    `Daily 10k-neuron quota likely exhausted across the pool.`,
  )
}

/** Today in UTC as YYYY-MM-DD — matches Cloudflare's neuron-counter reset. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Atomically increment per-row call counters. Resets calls_today to 1 if
 * last_call_date is in a previous UTC day. Always writes last_call_at = now.
 */
export function recordAiKeyCall(id: number): void {
  ensureCfAiKeysSchema()
  const today = todayUtc()
  const db = getDb()
  db.exec("BEGIN IMMEDIATE")
  try {
    db.prepare(
      `UPDATE cf_workers_ai_keys
          SET calls_today = CASE
                WHEN last_call_date = ? THEN calls_today + 1
                ELSE 1
              END,
              calls_total   = calls_total + 1,
              last_call_at  = datetime('now'),
              last_call_date = ?,
              last_error    = NULL
        WHERE id = ?`,
    ).run(today, today, id)
    db.exec("COMMIT")
  } catch (e) {
    try { db.exec("ROLLBACK") } catch { /* ignore */ }
    throw e
  }
}

export function recordAiKeyError(id: number, message: string): void {
  ensureCfAiKeysSchema()
  const trimmed = message.length > 400 ? message.slice(0, 397) + "..." : message
  getDb()
    .prepare("UPDATE cf_workers_ai_keys SET last_error = ? WHERE id = ?")
    .run(trimmed, id)
}

/** Count of active pool rows — used by the dashboard to render "free budget". */
export function countActiveAiKeys(): number {
  ensureCfAiKeysSchema()
  return one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM cf_workers_ai_keys WHERE is_active = 1",
  )?.n ?? 0
}
