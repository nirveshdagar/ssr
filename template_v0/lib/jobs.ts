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

const handlers = new Map<string, JobHandler>()
const POLL_INTERVAL_MS = 2000

let poolStop = false
const poolThreads: Promise<void>[] = []
let poolStarted = false

const WORKER_ID_BASE = `node-pid-${process.pid}`

function defaultWorkers(): number {
  const raw = process.env.SSR_JOB_WORKERS
  if (!raw) return 4
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return 4
  return Math.max(1, n)
}

export function registerHandler(kind: string, fn: JobHandler): void {
  if (handlers.has(kind)) {
    throw new Error(`handler for ${JSON.stringify(kind)} already registered (Node side)`)
  }
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
  // Failed: any 'running' that already exhausted its attempts.
  const failed = run(
    `UPDATE jobs
        SET status = 'failed',
            last_error = COALESCE(last_error, '') || ' | orphaned: process restarted mid-run',
            locked_by = NULL, locked_at = NULL, updated_at = ?
      WHERE status = 'running' AND attempt_count >= max_attempts`,
    now,
  )
  // Requeue the rest.
  const requeued = run(
    `UPDATE jobs
        SET status = 'queued', locked_by = NULL, locked_at = NULL, updated_at = ?
      WHERE status = 'running'`,
    now,
  )
  return Number(failed.changes) + Number(requeued.changes)
}

function claimOne(workerId: string): JobRow | null {
  const now = Date.now() / 1000
  const db = getDb()
  // SELECT-then-UPDATE with status guard. SQLite serializes writes; the
  // guard makes the loser's UPDATE a no-op (rowcount=0).
  const row = db.prepare(
    `SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1`,
  ).get() as { id: number } | undefined
  if (!row) return null
  const updated = db.prepare(
    `UPDATE jobs
        SET status = 'running', attempt_count = attempt_count + 1,
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

function requeueForRetry(id: number, error: string): void {
  const now = Date.now() / 1000
  run(
    `UPDATE jobs
        SET status = 'queued', last_error = ?, locked_by = NULL, locked_at = NULL, updated_at = ?
      WHERE id = ?`,
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
    if (job.attempt_count < job.max_attempts) {
      requeueForRetry(job.id, err)
    } else {
      finishJob(job.id, "failed", err)
    }
  }
}

async function workerLoop(workerId: string): Promise<void> {
  while (!poolStop) {
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
  if (poolStarted) return
  poolStarted = true
  poolStop = false
  recoverOrphans()
  for (let i = 0; i < numWorkers; i++) {
    const id = `${WORKER_ID_BASE}-w${i}`
    poolThreads.push(workerLoop(id))
  }
}

export async function stopPool(): Promise<void> {
  poolStop = true
  await Promise.all(poolThreads)
  poolThreads.length = 0
  poolStarted = false
}
