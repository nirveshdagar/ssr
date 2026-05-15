/**
 * Daily cleanup of unbounded log tables — pipeline_log, audit_log,
 * pipeline_runs. Without this, dashboard queries slow as rows accumulate
 * (millions on a 10k-domain instance with the 1s heartbeat ticker).
 *
 * Defaults:
 *   pipeline_log → keep 30 days
 *   audit_log    → keep 90 days  (longer retention — incident forensics)
 *   pipeline_runs → keep 14 days
 *
 * Disable: SSR_LOG_RETENTION=0.
 * Override windows via SSR_RETAIN_PIPELINE_LOG_DAYS / _AUDIT_DAYS / _RUNS_DAYS.
 *
 * Skipped automatically in NODE_ENV=test.
 */

import { run } from "./db"
import { logPipeline } from "./repos/logs"

const ONE_DAY_MS = 24 * 60 * 60 * 1000

function daysFromEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || "", 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

interface RetentionResult {
  pipeline_log: number
  audit_log: number
  pipeline_runs: number
}

export function rotateLogs(): RetentionResult {
  const pl = daysFromEnv("SSR_RETAIN_PIPELINE_LOG_DAYS", 30)
  const al = daysFromEnv("SSR_RETAIN_AUDIT_DAYS", 90)
  const pr = daysFromEnv("SSR_RETAIN_RUNS_DAYS", 14)

  // datetime('now', '-N days') is SQLite's relative-time arithmetic.
  const r1 = run(
    "DELETE FROM pipeline_log WHERE created_at < datetime('now', ?)",
    `-${pl} days`,
  )
  const r2 = run(
    "DELETE FROM audit_log WHERE created_at < datetime('now', ?)",
    `-${al} days`,
  )
  // pipeline_runs uses started_at (REAL unix seconds) and pipeline_step_runs
  // FK-references it. Cascade behavior depends on schema; clean step_runs
  // first to avoid leaving orphans if FKs aren't enforced on prod schema.
  const cutoff = (Date.now() / 1000) - (pr * 86400)
  run(
    `DELETE FROM pipeline_step_runs
      WHERE run_id IN (SELECT id FROM pipeline_runs WHERE started_at < ?)`,
    cutoff,
  )
  const r3 = run("DELETE FROM pipeline_runs WHERE started_at < ?", cutoff)

  return {
    pipeline_log: Number(r1.changes),
    audit_log: Number(r2.changes),
    pipeline_runs: Number(r3.changes),
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __ssrLogRetentionTimer: ReturnType<typeof setInterval> | undefined
  // eslint-disable-next-line no-var
  var __ssrLogRetentionScheduled: boolean | undefined
}

export function startLogRetention(): void {
  if (globalThis.__ssrLogRetentionScheduled) return
  if (process.env.NODE_ENV === "test") return
  if (process.env.SSR_LOG_RETENTION === "0") return
  globalThis.__ssrLogRetentionScheduled = true

  // First run 90s after boot (after sweepers, before backup), then every 24h.
  setTimeout(runOnce, 90_000).unref?.()
  globalThis.__ssrLogRetentionTimer = setInterval(runOnce, ONE_DAY_MS)
  globalThis.__ssrLogRetentionTimer.unref?.()
}

function runOnce(): void {
  try {
    const r = rotateLogs()
    if (r.pipeline_log + r.audit_log + r.pipeline_runs > 0) {
      logPipeline("(retention)", "log_rotation", "completed",
        `pipeline_log=${r.pipeline_log} audit_log=${r.audit_log} runs=${r.pipeline_runs}`)
    }
  } catch (e) {
    logPipeline("(retention)", "log_rotation", "warning",
      `rotation failed: ${(e as Error).message}`)
  }
}
