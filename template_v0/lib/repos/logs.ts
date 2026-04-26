import { all } from "../db"

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

export function getSteps(domain: string): StepTrackerRow[] {
  return all<StepTrackerRow>(
    `SELECT * FROM step_tracker WHERE domain = ? ORDER BY step_num ASC`,
    domain,
  )
}
