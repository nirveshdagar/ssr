import { all, run } from "../db"

// Cap on the freeform `message` column. CF/SA error bodies can be many KiB,
// and pipeline_log writes from request handlers interpolate them directly —
// without this cap, the table grows fast under failure storms and dashboard
// queries slow down. 2 KiB is enough for human messages + one stack-shaped
// error head; truncation marker tells the operator to look at the full
// stack via the run details / step artifact.
const LOG_MESSAGE_MAX = 2048

export function logPipeline(domain: string, step: string, status: string, message = ""): void {
  const safe = message && message.length > LOG_MESSAGE_MAX
    ? message.slice(0, LOG_MESSAGE_MAX) + ` …[truncated; original ${message.length} chars]`
    : message
  run(
    "INSERT INTO pipeline_log(domain,step,status,message) VALUES(?,?,?,?)",
    domain,
    step,
    status,
    safe,
  )
}

export interface PipelineLogRow {
  id: number
  domain: string
  step: string
  status: string
  message: string | null
  created_at: string
}

export function listPipelineLogs(opts: { domain?: string | null; limit?: number } = {}): PipelineLogRow[] {
  const limit = opts.limit ?? 200
  if (opts.domain) {
    return all<PipelineLogRow>(
      `SELECT * FROM pipeline_log WHERE domain = ? ORDER BY id DESC LIMIT ?`,
      opts.domain,
      limit,
    )
  }
  return all<PipelineLogRow>(
    `SELECT * FROM pipeline_log ORDER BY id DESC LIMIT ?`,
    limit,
  )
}

// step_tracker types and helpers live in repos/steps.ts (see getSteps,
// StepTrackerRow there). They moved when watcher helpers were consolidated.
