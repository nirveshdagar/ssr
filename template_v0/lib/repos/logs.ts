import { all, run } from "../db"

export function logPipeline(domain: string, step: string, status: string, message = ""): void {
  run(
    "INSERT INTO pipeline_log(domain,step,status,message) VALUES(?,?,?,?)",
    domain,
    step,
    status,
    message,
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
