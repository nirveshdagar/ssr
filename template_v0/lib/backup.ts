/**
 * Daily backup of `data/ssr.db` + the Fernet key file.
 *
 * Uses `VACUUM INTO` (not `db.backup()` — node:sqlite doesn't expose the
 * Online Backup API). VACUUM INTO writes a fresh, optimized copy of the
 * database while holding only a read lock; concurrent writers block briefly
 * but don't see torn state.
 *
 * The key file is single-copied alongside — without it the encrypted
 * settings columns become unreadable, so a DB-only backup is useless for
 * disaster recovery.
 *
 * Retention: N=7 daily files (override via SSR_BACKUP_KEEP_DAYS).
 * Disable: SSR_BACKUPS=0.
 * Skipped automatically in NODE_ENV=test.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import path from "node:path"
import { getDb } from "./db"
import { logPipeline } from "./repos/logs"

function resolveDbPath(): string {
  return process.env.SSR_DB_PATH
    ?? path.resolve(process.cwd(), "..", "data", "ssr.db")
}

function resolveBackupDir(): string {
  if (process.env.SSR_BACKUP_DIR) return process.env.SSR_BACKUP_DIR
  return path.join(path.dirname(resolveDbPath()), "backups")
}

function resolveFernetKeyPath(): string {
  if (process.env.SSR_FERNET_KEY_PATH) return process.env.SSR_FERNET_KEY_PATH
  return path.join(path.dirname(resolveDbPath()), ".ssr_secret_fernet")
}

function utcDateTag(d: Date): string {
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(d.getUTCDate()).padStart(2, "0")
  return `${yyyy}${mm}${dd}`
}

function keepDays(): number {
  const n = parseInt(process.env.SSR_BACKUP_KEEP_DAYS || "7", 10)
  return Number.isFinite(n) && n > 0 ? n : 7
}

export interface BackupResult {
  ok: boolean
  dbPath?: string
  fernetPath?: string
  rotated?: number
  error?: string
}

export function backupDatabase(): BackupResult {
  try {
    const dir = resolveBackupDir()
    mkdirSync(dir, { recursive: true })
    const tag = utcDateTag(new Date())
    const dbOut = path.join(dir, `ssr-${tag}.db`)
    const tmp = path.join(dir, `ssr-${tag}.db.tmp-${process.pid}`)
    if (existsSync(tmp)) unlinkSync(tmp)
    // VACUUM INTO doesn't accept ? params; SQL-string-escape any single
    // quotes in the path (rare on disk paths but cheap to be safe).
    const safe = tmp.replace(/'/g, "''")
    getDb().exec(`VACUUM INTO '${safe}'`)
    if (existsSync(dbOut)) unlinkSync(dbOut)
    renameSync(tmp, dbOut)

    let fernetOut: string | undefined
    const fernet = resolveFernetKeyPath()
    if (existsSync(fernet)) {
      fernetOut = path.join(dir, `.ssr_secret_fernet-${tag}`)
      copyFileSync(fernet, fernetOut)
    }

    const rotated = rotateOldBackups(dir, keepDays())
    return { ok: true, dbPath: dbOut, fernetPath: fernetOut, rotated }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

function rotateOldBackups(dir: string, keep: number): number {
  const cutoffMs = Date.now() - keep * 86400_000
  let removed = 0
  for (const f of readdirSync(dir)) {
    const isOurs =
      (f.startsWith("ssr-") && (f.endsWith(".db") || f.includes(".db.tmp-"))) ||
      f.startsWith(".ssr_secret_fernet-")
    if (!isOurs) continue
    const full = path.join(dir, f)
    try {
      const st = statSync(full)
      if (st.mtimeMs < cutoffMs) {
        unlinkSync(full)
        removed++
      }
    } catch { /* skip */ }
  }
  return removed
}

declare global {
  // eslint-disable-next-line no-var
  var __ssrBackupTimer: ReturnType<typeof setInterval> | undefined
  // eslint-disable-next-line no-var
  var __ssrBackupScheduled: boolean | undefined
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export function startDailyBackup(): void {
  if (globalThis.__ssrBackupScheduled) return
  if (process.env.NODE_ENV === "test") return
  if (process.env.SSR_BACKUPS === "0") return
  globalThis.__ssrBackupScheduled = true
  // First run 60s after boot so init + sweepers settle, then every 24h.
  setTimeout(runOnce, 60_000).unref?.()
  globalThis.__ssrBackupTimer = setInterval(runOnce, ONE_DAY_MS)
  globalThis.__ssrBackupTimer.unref?.()
}

function runOnce(): void {
  const r = backupDatabase()
  if (r.ok) {
    logPipeline("(backup)", "db_backup", "completed",
      `db=${r.dbPath} fernet=${r.fernetPath ?? "(none)"} rotated=${r.rotated ?? 0}`)
    return
  }
  logPipeline("(backup)", "db_backup", "failed", `backup error: ${r.error}`)
  void import("./notify").then(({ notify }) =>
    notify("Database backup failed", r.error ?? "(unknown error)", {
      severity: "error", dedupeKey: "db_backup_failed",
    }),
  ).catch(() => { /* notify is best-effort */ })
}
