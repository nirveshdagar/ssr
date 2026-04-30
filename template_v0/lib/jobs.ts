/**
 * Durable, DB-backed job queue — Node port of modules/jobs.py.
 *
 * Same `jobs` table the Flask side uses. Workers poll every 2s, claim
 * one row at a time, dispatch to a registered handler, write status +
 * last_error back. Boot recovery resets stuck 'running' rows.
 *
 * Single in-process pool of N async workers (default 4). Tunable via
 * SSR_JOB_WORKERS env var. Async/await for the loop, but each handler
 * runs to completion before the worker claims the next row — same
 * single-job-per-worker semantics as the Python version.
 *
 * The Flask job worker pool ALSO polls this same table. If both are
 * running side-by-side, whichever pool's worker wins the
 * `AND status='queued'` UPDATE race claims the row. For now we
 * recommend running ONE worker pool at a time to avoid double-pickup
 * confusion (set SSR_JOB_WORKERS=0 on whichever side you want quiet).
 */
import { all, getDb, one, run } from "./db"

export type JobHandler = (payload: Record<string, unknown>) => void | Promise<void>

export interface JobRow {
  id: number
  kind: string
  payload_json: string
  status: string
  attempt_count: number
  max_attempts: number
  locked_by: string | null
  locked_at: number | null
  last_error: string | null
  created_at: number
  updated_at: number
}

const POLL_INTERVAL_MS = 2000

// HMR-safe state. Next dev / Turbopack re-evaluates this module on edits;
// keeping these on globalThis means each re-eval reuses the existing pool
// instead of spawning a fresh set of workers while the old loops keep
// polling. Fixes the multi-pool leak that compounded the CPU spike.
declare global {
  // eslint-disable-next-line no-var
  var __ssrJobPool: { started: boolean; stop: boolean; threads: Promise<void>[] } | undefined
  // eslint-disable-next-line no-var
  var __ssrJobHandlers: Map<string, JobHandler> | undefined
}
const pool = (globalThis.__ssrJobPool ??= { started: false, stop: false, threads: [] })
const handlers = (globalThis.__ssrJobHandlers ??= new Map<string, JobHandler>())

const WORKER_ID_BASE = `node-pid-${process.pid}`

function defaultWorkers(): number {
  const raw = process.env.SSR_JOB_WORKERS
  if (!raw) return 4
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return 4
  return Math.max(1, n)
}

export function registerHandler(kind: string, fn: JobHandler): void {
  // Idempotent re-register: HMR re-runs instrumentation, which re-imports
  // pipeline/cf-bulk/etc. and calls registerHandler again. Throwing here
  // would spam errors on every dev edit; replacing the entry is fine since
  // the new function is the latest source.
  handlers.set(kind, fn)
}

export function enqueueJob(kind: string, payload: unknown, maxAttempts = 1): number {
  const now = Date.now() / 1000
  const result = run(
    `INSERT INTO jobs (kind, payload_json, status, attempt_count, max_attempts, created_at, updated_at)
       VALUES (?, ?, 'queued', 0, ?, ?, ?)`,
    kind,
    JSON.stringify(payload),
    maxAttempts,
    now,
    now,
  )
  return Number(result.lastInsertRowid)
}

export function getJob(id: number): JobRow | undefined {
  return one<JobRow>("SELECT * FROM jobs WHERE id = ?", id)
}

export function listJobs(opts: { status?: string; kind?: string; limit?: number } = {}): JobRow[] {
  const where: string[] = []
  const args: (string | number)[] = []
  if (opts.status) { where.push("status = ?"); args.push(opts.status) }
  if (opts.kind)   { where.push("kind = ?");   args.push(opts.kind) }
  let sql = "SELECT * FROM jobs"
  if (where.length) sql += " WHERE " + where.join(" AND ")
  sql += " ORDER BY id DESC LIMIT ?"
  args.push(opts.limit ?? 50)
  return all<JobRow>(sql, ...args)
}

export function recoverOrphans(): number {
  const now = Date.now() / 1000
  // attempt_count is incremented on FAILURE (in runOne), not on CLAIM,
  // so a crashed worker leaves the row at its pre-claim count. The check
  // below correctly fails only jobs that have actually exhausted their
  // recorded attempts; everything else gets requeued for another try.
  const failed = run(
    `UPDATE jobs
        SET status = 'failed',
            last_error = COALESCE(last_error, '') || ' | orphaned: process restarted mid-run',
            locked_by = NULL, locked_at = NULL, updated_at = ?
      WHERE status = 'running' AND attempt_count >= max_attempts`,
    now,
  )
  // Mark pipeline.full orphans whose domain is already at a success status
  // as 'done' instead of requeueing — otherwise a worker killed AFTER its
  // pipeline finished but BEFORE finishJob() runs would re-fire the whole
  // pipeline (step 4 hits Spaceship, step 5 polls CF for 2 min) on a
  // domain that's already serving. Inline the success-status list rather
  // than importing from status-taxonomy to avoid a cycle.
  const skippedDone = run(
    `UPDATE jobs
        SET status = 'done',
            last_error = COALESCE(last_error, '') || ' | orphan recovered: domain already at success',
            locked_by = NULL, locked_at = NULL, updated_at = ?
      WHERE status = 'running'
        AND kind = 'pipeline.full'
        AND EXISTS (
          SELECT 1 FROM domains d
          WHERE d.domain = json_extract(jobs.payload_json, '$.domain')
            AND d.status IN ('hosted', 'live', 'completed')
        )`,
    now,
  )
  // Requeue the rest.
  const requeued = run(
    `UPDATE jobs
        SET status = 'queued', locked_by = NULL, locked_at = NULL, updated_at = ?
      WHERE status = 'running'`,
    now,
  )
  return Number(failed.changes) + Number(skippedDone.changes) + Number(requeued.changes)
}

/**
 * Soft variant of `recoverOrphans` for the in-process stuck-job sweeper.
 * Only requeues rows that have been `running` long enough to be considered
 * stuck (default 30 min). Used by the scheduled sweeper so a worker that
 * silently dies — e.g. an upstream `await` that never resolves and isn't
 * caught by Node's process-level handler — gets its job back to the queue
 * within bounded time instead of waiting for the next process restart.
 */
export function recoverStuckJobs(stuckAfterSeconds = 1800): number {
  const now = Date.now() / 1000
  const cutoff = now - stuckAfterSeconds
  const failed = run(
    `UPDATE jobs
        SET status = 'failed',
            last_error = COALESCE(last_error, '') || ' | stuck: locked > ' || ? || 's, attempts exhausted',
            locked_by = NULL, locked_at = NULL, updated_at = ?
      WHERE status = 'running'
        AND locked_at IS NOT NULL AND locked_at < ?
        AND attempt_count >= max_attempts`,
    stuckAfterSeconds,
    now,
    cutoff,
  )
  const requeued = run(
    `UPDATE jobs
        SET status = 'queued',
            last_error = COALESCE(last_error, '') || ' | stuck: locked > ' || ? || 's, requeued',
            locked_by = NULL, locked_at = NULL, updated_at = ?
      WHERE status = 'running'
        AND locked_at IS NOT NULL AND locked_at < ?`,
    stuckAfterSeconds,
    now,
    cutoff,
  )
  return Number(failed.changes) + Number(requeued.changes)
}

function claimOne(workerId: string): JobRow | null {
  const now = Date.now() / 1000
  const db = getDb()
  // SELECT-then-UPDATE with status guard. SQLite serializes writes; the
  // guard makes the loser's UPDATE a no-op (rowcount=0).
  // attempt_count is intentionally NOT incremented here — it ticks up only
  // on actual failure, so a worker that crashes mid-handler doesn't burn
  // an attempt. Recovery is then accurate (see recoverOrphans).
  const row = db.prepare(
    `SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1`,
  ).get() as { id: number } | undefined
  if (!row) return null
  const updated = db.prepare(
    `UPDATE jobs
        SET status = 'running',
            locked_by = ?, locked_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued'`,
  ).run(workerId, now, now, row.id)
  if (Number(updated.changes) === 0) return null
  return one<JobRow>("SELECT * FROM jobs WHERE id = ?", row.id) ?? null
}

function finishJob(id: number, status: string, error: string | null = null): void {
  const now = Date.now() / 1000
  run(
    `UPDATE jobs
        SET status = ?, last_error = ?, locked_by = NULL, locked_at = NULL, updated_at = ?
      WHERE id = ?`,
    status,
    error,
    now,
    id,
  )
}

function failJobIncrement(id: number, error: string, newCount: number): void {
  const now = Date.now() / 1000
  run(
    `UPDATE jobs
        SET status = 'failed', attempt_count = ?, last_error = ?,
            locked_by = NULL, locked_at = NULL, updated_at = ?
      WHERE id = ?`,
    newCount,
    error,
    now,
    id,
  )
}

function requeueForRetry(id: number, error: string, newCount: number): void {
  const now = Date.now() / 1000
  run(
    `UPDATE jobs
        SET status = 'queued', attempt_count = ?, last_error = ?,
            locked_by = NULL, locked_at = NULL, updated_at = ?
      WHERE id = ?`,
    newCount,
    error,
    now,
    id,
  )
}

async function runOne(job: JobRow): Promise<void> {
  const fn = handlers.get(job.kind)
  if (!fn) {
    finishJob(job.id, "failed", `No handler registered for kind=${JSON.stringify(job.kind)}`)
    return
  }
  let payload: unknown
  try {
    payload = JSON.parse(job.payload_json)
  } catch (e) {
    finishJob(job.id, "failed", `Bad payload JSON: ${(e as Error).message}`)
    return
  }
  try {
    await fn(payload as Record<string, unknown>)
    finishJob(job.id, "done")
  } catch (e) {
    const err = `${(e as Error).name}: ${(e as Error).message}`
    // Increment attempt_count on actual failure (not on claim) so a crashed
    // worker doesn't burn an attempt. After this increment, if the row has
    // recorded N >= max_attempts failures, it's terminal; otherwise requeue.
    const newCount = job.attempt_count + 1
    if (newCount < job.max_attempts) {
      requeueForRetry(job.id, err, newCount)
    } else {
      failJobIncrement(job.id, err, newCount)
    }
  }
}

async function workerLoop(workerId: string): Promise<void> {
  while (!pool.stop) {
    let job: JobRow | null = null
    try {
      job = claimOne(workerId)
    } catch (e) {
      // Don't tight-loop on DB errors.
      await sleep(POLL_INTERVAL_MS * 2)
      continue
    }
    if (!job) {
      await sleep(POLL_INTERVAL_MS)
      continue
    }
    await runOne(job)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function startPool(numWorkers = defaultWorkers()): void {
  if (pool.started) return
  pool.started = true
  pool.stop = false
  recoverOrphans()
  for (let i = 0; i < numWorkers; i++) {
    const id = `${WORKER_ID_BASE}-w${i}`
    pool.threads.push(workerLoop(id))
  }
  startStuckJobSweeper()
}

export async function stopPool(): Promise<void> {
  pool.stop = true
  await Promise.all(pool.threads)
  pool.threads.length = 0
  pool.started = false
  if (globalThis.__ssrStuckJobTimer) {
    clearInterval(globalThis.__ssrStuckJobTimer)
    globalThis.__ssrStuckJobTimer = undefined
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __ssrStuckJobTimer: ReturnType<typeof setInterval> | undefined
}

const STUCK_SWEEP_INTERVAL_MS = 5 * 60 * 1000

/**
 * In-process sweeper: every 5 min, walks the jobs table for `running` rows
 * locked > 30 min and either requeues them (if attempts remain) or marks
 * them failed. Closes the gap where a worker silently wedges (await that
 * never resolves, sync infinite loop, GC pause) and the row sits running
 * forever — recoverOrphans only runs at boot.
 */
function startStuckJobSweeper(): void {
  if (globalThis.__ssrStuckJobTimer) return
  if (process.env.NODE_ENV === "test") return
  if (process.env.SSR_JOB_SWEEPER === "0") return
  const stuckAfter = parseStuckAfterSeconds()
  globalThis.__ssrStuckJobTimer = setInterval(() => {
    try {
      const n = recoverStuckJobs(stuckAfter)
      if (n > 0) {
        // eslint-disable-next-line no-console
        console.log(`[jobs] stuck-job sweeper recovered ${n} row(s)`)
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[jobs] stuck-job sweeper failed:", e)
    }
  }, STUCK_SWEEP_INTERVAL_MS)
  globalThis.__ssrStuckJobTimer.unref?.()
}

function parseStuckAfterSeconds(): number {
  const n = parseInt(process.env.SSR_JOB_STUCK_AFTER_S || "1800", 10)
  return Number.isFinite(n) && n >= 60 ? n : 1800
}
