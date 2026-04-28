/**
 * Step tracker + pipeline runs — Node port of the watcher/audit DB helpers
 * in database.py.
 *
 * Tables (Flask-managed schema):
 *   - step_tracker         latest-attempt-only per (domain, step_num); used by
 *                          the watcher UI for live progress
 *   - pipeline_runs        one row per pipeline invocation (status, params, ts)
 *   - pipeline_step_runs   one row per (run_id, step_num); full history
 *
 * The Flask side owns the schema; we reuse it. Both apps' workers can write
 * here concurrently because writes are short and SQLite serializes them.
 */
import { all, getDb, one, run } from "../db"
import { PIPELINE_STEPS as TAXONOMY_PIPELINE_STEPS } from "../status-taxonomy"

/** Re-exported for back-compat — taxonomy.PIPELINE_STEPS is canonical. */
export const PIPELINE_STEPS: Record<number, string> = { ...TAXONOMY_PIPELINE_STEPS }

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "warning"

// ---------------------------------------------------------------------------
// Heartbeat — pipeline workers pulse every ~1s so the watcher can
// distinguish "still working" from "crashed/dead"
// ---------------------------------------------------------------------------

export function heartbeat(domain: string): void {
  run(
    "UPDATE domains SET last_heartbeat_at = datetime('now') WHERE domain = ?",
    domain,
  )
}

/**
 * Background heartbeat ticker. Pulses `domains.last_heartbeat_at` every
 * `intervalMs` for one or many domains until `stop()` is called.
 *
 * Use this around any worker that holds a domain's pipeline/migration slot
 * for >5s. Migration's per-domain SSL install + content upload regularly
 * crosses 30s; cert-backfill on a 60-domain fleet sits in CF round-trip
 * land for ~2 min total. Without a heartbeat the watcher would otherwise
 * mark the row as stale and the dashboard's "active watchers" set goes
 * empty — operators would think the worker died.
 *
 * Safe with an empty array (no-op). Each write is wrapped in try/catch so
 * a transient DB hiccup never kills the worker.
 */
export function startHeartbeat(
  domain: string | string[],
  intervalMs = 1000,
): { stop: () => void } {
  const domains = Array.isArray(domain) ? domain : [domain]
  if (domains.length === 0) return { stop: () => { /* no-op */ } }
  // Pulse once immediately so the watcher sees activity within the first
  // interval, not only after `intervalMs` has elapsed.
  for (const d of domains) {
    try { heartbeat(d) } catch { /* ignore */ }
  }
  const handle = setInterval(() => {
    for (const d of domains) {
      try { heartbeat(d) } catch { /* DB hiccups shouldn't kill the worker */ }
    }
  }, intervalMs)
  return { stop: () => clearInterval(handle) }
}

// ---------------------------------------------------------------------------
// step_tracker — reset per pipeline start, then update_step on each transition
// ---------------------------------------------------------------------------

/**
 * Insert step_tracker rows for every step on first sight, AND reset only
 * incomplete steps to 'pending' on subsequent calls.
 *
 * Critical: a previously-`completed` (or `skipped`) step is left alone, so
 * a retry of a partially-failed pipeline doesn't "unlock" already-done
 * work. Without this preservation, every retry would re-run step 8's
 * 1-minute SA UI SSL install just because step 9 hiccuped, etc.
 *
 * Step idempotency checks at the top of each step function read
 * step_tracker; combined with this preservation, "completed" becomes a
 * sticky lock that survives retries.
 */
export function initSteps(domain: string): void {
  for (const [numStr, name] of Object.entries(PIPELINE_STEPS)) {
    run(
      `INSERT INTO step_tracker(domain, step_num, step_name, status, message)
       VALUES(?, ?, ?, 'pending', '')
       ON CONFLICT(domain, step_num)
       DO UPDATE SET
         status = CASE
           WHEN step_tracker.status IN ('completed', 'skipped') THEN step_tracker.status
           ELSE 'pending'
         END,
         message = CASE
           WHEN step_tracker.status IN ('completed', 'skipped') THEN step_tracker.message
           ELSE ''
         END,
         started_at = CASE
           WHEN step_tracker.status IN ('completed', 'skipped') THEN step_tracker.started_at
           ELSE NULL
         END,
         finished_at = CASE
           WHEN step_tracker.status IN ('completed', 'skipped') THEN step_tracker.finished_at
           ELSE NULL
         END`,
      domain, parseInt(numStr, 10), name,
    )
  }
}

/**
 * Operator-facing reset: explicitly clear step N (and all later steps)
 * back to 'pending'. Called when the operator hits "Run from step N" so
 * the lock from prior runs of those steps is released and they can re-run.
 * Steps 1..N-1 are deliberately preserved as-is.
 */
export function resetStepsFrom(domain: string, fromStep: number): void {
  run(
    `UPDATE step_tracker
        SET status='pending', message='', started_at=NULL, finished_at=NULL
      WHERE domain = ? AND step_num >= ?`,
    domain, fromStep,
  )
}

/**
 * Update step_tracker for the latest attempt + mirror into pipeline_step_runs
 * scoped to the active (running) pipeline_runs row, if any.
 *
 * Mirrors database.update_step() exactly — preserve started_at/ended_at once
 * set so first-transition timestamps stick across re-updates within a run.
 */
export function updateStep(
  domain: string,
  stepNum: number,
  status: StepStatus,
  message = "",
): void {
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "")
  if (status === "running") {
    run(
      `UPDATE step_tracker SET status = ?, message = ?, started_at = ?
       WHERE domain = ? AND step_num = ?`,
      status, message, nowIso, domain, stepNum,
    )
  } else if (status === "completed" || status === "failed" || status === "skipped" || status === "warning") {
    run(
      `UPDATE step_tracker SET status = ?, message = ?, finished_at = ?
       WHERE domain = ? AND step_num = ?`,
      status, message, nowIso, domain, stepNum,
    )
  } else {
    run(
      `UPDATE step_tracker SET status = ?, message = ? WHERE domain = ? AND step_num = ?`,
      status, message, domain, stepNum,
    )
  }

  // Mirror into pipeline_step_runs if we have an active run
  const runRow = one<{ id: number }>(
    `SELECT id FROM pipeline_runs WHERE domain = ? AND status = 'running'
     ORDER BY id DESC LIMIT 1`,
    domain,
  )
  if (!runRow) return
  const runId = runRow.id
  const nowReal = Date.now() / 1000
  const isTerminal = status === "completed" || status === "failed" ||
    status === "skipped" || status === "warning"

  const existing = one<{ id: number }>(
    `SELECT id FROM pipeline_step_runs WHERE run_id = ? AND step_num = ?`,
    runId, stepNum,
  )
  if (!existing) {
    run(
      `INSERT INTO pipeline_step_runs
         (run_id, step_num, status, attempt, started_at, ended_at, message)
       VALUES(?, ?, ?, 1, ?, ?, ?)`,
      runId, stepNum, status,
      status === "running" ? nowReal : null,
      isTerminal ? nowReal : null,
      message,
    )
  } else {
    run(
      `UPDATE pipeline_step_runs
          SET status = ?,
              message = ?,
              started_at = COALESCE(started_at, CASE WHEN ? = 'running' THEN ? END),
              ended_at = COALESCE(ended_at, CASE WHEN ? THEN ? END)
        WHERE id = ?`,
      status, message,
      status, nowReal,
      isTerminal ? 1 : 0, nowReal,
      existing.id,
    )
  }
}

// ---------------------------------------------------------------------------
// pipeline_runs lifecycle
// ---------------------------------------------------------------------------

export function startPipelineRun(
  domain: string, params: Record<string, unknown> | null = null, jobId: number | null = null,
): number {
  const r = run(
    `INSERT INTO pipeline_runs(domain, job_id, status, params_json, started_at)
     VALUES(?, ?, 'running', ?, ?)`,
    domain, jobId,
    params ? JSON.stringify(params) : null,
    Date.now() / 1000,
  )
  return Number(r.lastInsertRowid)
}

export function endPipelineRun(
  runId: number, status: "completed" | "failed" | "canceled" | "waiting", error: string | null = null,
): void {
  run(
    `UPDATE pipeline_runs SET status = ?, error = ?, ended_at = ? WHERE id = ?`,
    status, error, Date.now() / 1000, runId,
  )
}

// ---------------------------------------------------------------------------
// pipeline_step_runs.artifact_json — shallow merge under transactional guard
// ---------------------------------------------------------------------------

export function setStepArtifact(
  domain: string, stepNum: number, artifact: Record<string, unknown>,
): void {
  const db = getDb()
  db.exec("BEGIN IMMEDIATE")
  try {
    const runRow = db.prepare(
      `SELECT id FROM pipeline_runs WHERE domain = ? AND status = 'running'
       ORDER BY id DESC LIMIT 1`,
    ).get(domain) as { id: number } | undefined
    if (!runRow) { db.exec("COMMIT"); return }
    const stepRow = db.prepare(
      `SELECT id, artifact_json FROM pipeline_step_runs WHERE run_id = ? AND step_num = ?`,
    ).get(runRow.id, stepNum) as { id: number; artifact_json: string | null } | undefined
    if (!stepRow) { db.exec("COMMIT"); return }
    let merged: Record<string, unknown> = {}
    if (stepRow.artifact_json) {
      try { merged = JSON.parse(stepRow.artifact_json) as Record<string, unknown> } catch { /* discard */ }
    }
    merged = { ...merged, ...artifact }
    db.prepare(
      `UPDATE pipeline_step_runs SET artifact_json = ? WHERE id = ?`,
    ).run(JSON.stringify(merged), stepRow.id)
    db.exec("COMMIT")
  } catch (e) {
    try { db.exec("ROLLBACK") } catch { /* ignore */ }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Read helpers (used by /api/runs and the watcher pages)
// ---------------------------------------------------------------------------

export interface PipelineRunRow {
  id: number
  domain: string
  job_id: number | null
  status: string
  error: string | null
  params_json: string | null
  started_at: number | null
  ended_at: number | null
}

export function listPipelineRuns(domain: string, limit = 20): PipelineRunRow[] {
  return all<PipelineRunRow>(
    `SELECT * FROM pipeline_runs WHERE domain = ? ORDER BY id DESC LIMIT ?`,
    domain, limit,
  )
}

export function getPipelineRun(runId: number): PipelineRunRow | undefined {
  return one<PipelineRunRow>(`SELECT * FROM pipeline_runs WHERE id = ?`, runId)
}

export interface PipelineStepRunRow {
  id: number
  run_id: number
  step_num: number
  status: string
  attempt: number
  started_at: number | null
  ended_at: number | null
  message: string | null
  artifact_json: string | null
}

export function getStepRuns(runId: number): PipelineStepRunRow[] {
  return all<PipelineStepRunRow>(
    `SELECT * FROM pipeline_step_runs WHERE run_id = ? ORDER BY step_num, attempt`,
    runId,
  )
}

// ---------------------------------------------------------------------------
// Watcher helpers — used by dashboard KPIs + /watcher live polling
// ---------------------------------------------------------------------------

export interface StepTrackerRow {
  id: number
  domain: string
  step_num: number
  step_name: string
  status: string
  message: string
  started_at: string | null
  finished_at: string | null
}

/** Every step_tracker row, grouped by domain. Drives the watcher page. */
export function getWatcherSummary(): Record<string, StepTrackerRow[]> {
  const rows = all<StepTrackerRow>(
    `SELECT domain, step_num, step_name, status, message, started_at, finished_at
       FROM step_tracker ORDER BY domain, step_num`,
  )
  const out: Record<string, StepTrackerRow[]> = {}
  for (const r of rows) {
    if (!out[r.domain]) out[r.domain] = []
    out[r.domain].push(r)
  }
  return out
}

/** Domains with at least one step in 'running' state. */
export function getAllActiveWatchers(): string[] {
  return all<{ domain: string }>(
    `SELECT DISTINCT domain FROM step_tracker WHERE status = 'running'`,
  ).map((r) => r.domain)
}

/** Steps for one domain (used by /api/watcher/[domain]). */
export function getSteps(domain: string): StepTrackerRow[] {
  return all<StepTrackerRow>(
    `SELECT * FROM step_tracker WHERE domain = ? ORDER BY step_num ASC`,
    domain,
  )
}
