import { all, one } from "../db"

export interface PipelineRunRow {
  id: number
  domain: string
  job_id: number | null
  status: string
  params_json: string | null
  started_at: number
  ended_at: number | null
  error: string | null
}

export interface StepRunRow {
  id: number
  run_id: number
  step_num: number
  status: string
  attempt: number
  started_at: number | null
  ended_at: number | null
  message: string | null
  artifact_json: string | null
  error: string | null
}

export function listRunsForDomain(domain: string, limit = 20): PipelineRunRow[] {
  return all<PipelineRunRow>(
    `SELECT * FROM pipeline_runs WHERE domain = ? ORDER BY id DESC LIMIT ?`,
    domain,
    limit,
  )
}

export function getRun(runId: number): PipelineRunRow | undefined {
  return one<PipelineRunRow>("SELECT * FROM pipeline_runs WHERE id = ?", runId)
}

export function getStepRuns(runId: number): StepRunRow[] {
  return all<StepRunRow>(
    `SELECT * FROM pipeline_step_runs WHERE run_id = ? ORDER BY step_num, attempt`,
    runId,
  )
}
