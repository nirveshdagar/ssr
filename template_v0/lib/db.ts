/**
 * SQLite connection — shared with the Flask app.
 *
 * The Flask side owns init_db() (schema + idempotent migrations + seed).
 * This Next.js port READS AND WRITES the same `data/ssr.db` file, so both
 * apps see the same data. No schema duplication, no double-source-of-truth
 * during the migration phase.
 *
 * Path resolution:
 *   - SSR_DB_PATH env var (preferred; absolute path)
 *   - falls back to ../data/ssr.db relative to process.cwd()
 *
 * Runtime: a single Database instance is cached on globalThis so HMR
 * reloads don't leak handles in dev.
 */
import Database from "better-sqlite3"
import path from "node:path"

declare global {
  // eslint-disable-next-line no-var
  var __ssrDb: Database.Database | undefined
}

function resolveDbPath(): string {
  if (process.env.SSR_DB_PATH) return process.env.SSR_DB_PATH
  return path.resolve(process.cwd(), "..", "data", "ssr.db")
}

export function getDb(): Database.Database {
  if (globalThis.__ssrDb) return globalThis.__ssrDb
  const dbPath = resolveDbPath()
  const db = new Database(dbPath, { fileMustExist: false })
  // Match Flask side's pragmas exactly so concurrent access plays nice.
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 10000")
  globalThis.__ssrDb = db
  return db
}

/** Lightweight wrapper that returns rows as plain objects keyed by column. */
export function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...params) as T[]
}

export function one<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined
}

export function run(sql: string, ...params: unknown[]): Database.RunResult {
  return getDb().prepare(sql).run(...params)
}
