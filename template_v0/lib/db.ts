/**
 * SQLite connection — owned end-to-end by this Next.js app.
 *
 * Uses Node's built-in `node:sqlite` (Node 22+). No native build, no
 * Visual Studio toolchain required on Windows. The schema lives in
 * lib/init-schema.ts and runs on first connection — a wiped or fresh
 * `data/ssr.db` is safe (encrypted columns survive only as long as
 * `data/.ssr_secret_fernet` is preserved alongside).
 *
 * Path resolution:
 *   - SSR_DB_PATH env var (preferred; absolute path)
 *   - falls back to ../data/ssr.db relative to process.cwd()
 *
 * Runtime: a single DatabaseSync instance is cached on globalThis so
 * HMR reloads don't leak handles in dev.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite"
import path from "node:path"
import { mkdirSync } from "node:fs"
import { initSchema } from "./init-schema"

declare global {
  // eslint-disable-next-line no-var
  var __ssrDb: DatabaseSync | undefined
}

function resolveDbPath(): string {
  if (process.env.SSR_DB_PATH) return process.env.SSR_DB_PATH
  return path.resolve(process.cwd(), "..", "data", "ssr.db")
}

export function getDb(): DatabaseSync {
  if (globalThis.__ssrDb) return globalThis.__ssrDb
  const dbPath = resolveDbPath()
  // First-run convenience: data/ may not exist yet on a fresh checkout.
  // SQLite errors loudly if the directory is missing, so create it here.
  try { mkdirSync(path.dirname(dbPath), { recursive: true }) } catch { /* ignore */ }
  const db = new DatabaseSync(dbPath)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 10000")
  initSchema(db)
  globalThis.__ssrDb = db
  return db
}

/** Lightweight wrapper that returns rows as plain objects keyed by column. */
export function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  const stmt: StatementSync = getDb().prepare(sql)
  return stmt.all(...(params as never[])) as T[]
}

export function one<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  const stmt: StatementSync = getDb().prepare(sql)
  return stmt.get(...(params as never[])) as T | undefined
}

export function run(sql: string, ...params: unknown[]) {
  const stmt: StatementSync = getDb().prepare(sql)
  return stmt.run(...(params as never[]))
}
