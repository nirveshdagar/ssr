/**
 * Test fixture setup — points SSR_DB_PATH at a fresh temp file, then lets
 * the production schema bootstrap path (lib/init-schema.ts) create every
 * table on the first getDb() call. Each test file should call
 * `setupTestDb()` once and `cleanupTestDb()` after.
 *
 * History: this file used to inline a copy of database.py's CREATE TABLE
 * statements as SCHEMA_SQL. With the schema now owned by lib/init-schema.ts
 * (Flask is gone), the tests should exercise the same path prod uses on
 * fresh boot — that's what `setupTestDb` does now.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

let activeDir: string | null = null

export function setupTestDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ssr-test-"))
  const dbPath = path.join(dir, "test.db")
  process.env.SSR_DB_PATH = dbPath
  process.env.SSR_FERNET_KEY_PATH = path.join(dir, ".fernet")
  activeDir = dir
  // Reset module-level singletons BEFORE the first getDb() call so the
  // cached connection points at the new test path. Schema is created by
  // lib/init-schema.ts on the first getDb() — same path prod uses.
  delete (globalThis as Record<string, unknown>).__ssrDb
  delete (globalThis as Record<string, unknown>).__ssrInflightDomains
  delete (globalThis as Record<string, unknown>).__ssrDropletCreations
  return dbPath
}

export function cleanupTestDb(): void {
  if (activeDir) {
    try { rmSync(activeDir, { recursive: true, force: true }) } catch { /* ignore */ }
    activeDir = null
  }
  delete (globalThis as Record<string, unknown>).__ssrDb
  delete (globalThis as Record<string, unknown>).__ssrInflightDomains
  delete (globalThis as Record<string, unknown>).__ssrDropletCreations
}
