"use client"

import * as React from "react"
import { ChevronDown, ChevronRight, Copy, Play, ScrollText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { StatusBadge } from "@/components/ssr/status-badge"
import { domainActions } from "@/lib/api-actions"
import type { PipelineRunRow, PipelineStepRunRow } from "@/lib/repos/steps"
import { PIPELINE_STEPS as TAXONOMY_STEPS } from "@/lib/status-taxonomy"
import type { PipelineStatus } from "@/lib/ssr/mock-data"
import { cn } from "@/lib/utils"

const RUN_STATUS_TO_PIPELINE: Record<string, PipelineStatus> = {
  running: "running",
  completed: "completed",
  failed: "terminal_error",
  canceled: "canceled",
  waiting: "waiting",
}

interface Props {
  run: PipelineRunRow
  steps: PipelineStepRunRow[]
  startedHuman: string
  endedHuman: string
  dur: string
}

export function RunDetailClient({ run, steps, startedHuman, endedHuman, dur }: Props) {
  const params: Record<string, unknown> = (() => {
    if (!run.params_json) return {}
    try { return JSON.parse(run.params_json) as Record<string, unknown> } catch { return {} }
  })()
  const status = RUN_STATUS_TO_PIPELINE[run.status] ?? "pending"
  const [flash, setFlash] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)
  function show(kind: "ok" | "err", text: string) {
    setFlash({ kind, text })
    window.setTimeout(() => setFlash(null), 4500)
  }
  function copy(value: string, label: string) {
    if (!value) return
    navigator.clipboard?.writeText(value).then(
      () => show("ok", `${label} copied`),
      () => show("err", "Copy failed"),
    )
  }
  async function retryFromStep(stepNum: number) {
    if (!confirm(`Re-run pipeline for ${run.domain} starting at step ${stepNum}?`)) return
    const r = await domainActions.runFromStep(run.domain, stepNum)
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
  }

  return (
    <div className="flex flex-col gap-4">
      {flash && (
        <div
          role="status"
          className={cn(
            "rounded-md border px-3 py-2 text-small",
            flash.kind === "ok"
              ? "border-status-completed/40 bg-status-completed/10 text-status-completed"
              : "border-status-terminal/40 bg-status-terminal/10 text-status-terminal",
          )}
        >
          {flash.text}
        </div>
      )}

      {/* ===== Header ===== */}
      <section className="rounded-md border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
              <ScrollText className="h-5 w-5 text-muted-foreground" aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-semibold tracking-tight font-mono">run #{run.id}</h2>
                <StatusBadge status={status} />
                <a
                  href={`/domains/${encodeURIComponent(run.domain)}`}
                  className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-foreground/80 hover:bg-muted/70"
                  title="Open the domain detail page"
                >
                  {run.domain}
                </a>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>started {startedHuman}</span>
                {run.ended_at && <><span>·</span><span>ended {endedHuman}</span></>}
                <span>·</span>
                <span className="font-mono tabular-nums">duration {dur}</span>
                {run.job_id && (
                  <>
                    <span>·</span>
                    <span>job <code className="font-mono">#{run.job_id}</code></span>
                  </>
                )}
              </div>
              {run.error && (
                <p className="mt-2 rounded bg-status-terminal/10 px-2.5 py-1.5 font-mono text-[11px] text-status-terminal break-words">
                  {run.error}
                </p>
              )}
            </div>
          </div>
          <ButtonGroup>
            <a href={`/logs?domain=${encodeURIComponent(run.domain)}`}>
              <Button
                variant="outline" size="sm" className="gap-1.5"
                title={`Open the Logs page filtered to ${run.domain}`}
              >
                <ScrollText className="h-3.5 w-3.5" /> Open in Logs
              </Button>
            </a>
            <Button
              variant="outline" size="sm" className="gap-1.5 btn-soft-info"
              onClick={() => copy(window.location.href, "Run URL")}
              title="Copy this run URL to share with another operator"
            >
              <Copy className="h-3.5 w-3.5" /> Copy link
            </Button>
          </ButtonGroup>
        </header>

        {/* Run params */}
        {Object.keys(params).length > 0 && (
          <div className="px-5 py-3 border-b border-border">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
                Parameters
              </span>
              <button
                onClick={() => copy(JSON.stringify(params, null, 2), "Parameters JSON")}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
                title="Copy parameters JSON"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
            <pre className="font-mono text-[11px] leading-relaxed bg-muted/40 rounded p-2.5 overflow-x-auto">
              {JSON.stringify(params, null, 2)}
            </pre>
          </div>
        )}
      </section>

      {/* ===== Step list with collapsible artifact + copy buttons ===== */}
      <section className="rounded-md border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h3 className="text-[13px] font-semibold tracking-tight">Steps</h3>
          <span className="text-xs text-muted-foreground">{steps.length} recorded</span>
        </header>
        {steps.length === 0 ? (
          <div className="px-4 py-8 text-center text-small text-muted-foreground">
            No steps recorded yet for this run.
          </div>
        ) : (
          <ol className="divide-y divide-border">
            {steps.map((s) => (
              <StepRow
                key={`${s.step_num}-${s.attempt}`}
                step={s}
                onCopy={copy}
                onRetry={() => retryFromStep(s.step_num)}
              />
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

function StepRow({
  step, onCopy, onRetry,
}: {
  step: PipelineStepRunRow
  onCopy: (value: string, label: string) => void
  onRetry: () => void
}) {
  const [open, setOpen] = React.useState(step.status === "failed" || step.status === "warning")
  const stepName = TAXONOMY_STEPS[step.step_num] ?? `step ${step.step_num}`
  const dur = step.started_at && step.ended_at
    ? `${Math.round(step.ended_at - step.started_at)}s`
    : step.started_at ? "running" : "—"
  const stPipeline: PipelineStatus =
    step.status === "completed" ? "completed" :
    step.status === "failed" ? "terminal_error" :
    step.status === "running" ? "running" :
    step.status === "warning" ? "waiting" :
    step.status === "skipped" ? "completed" : "pending"

  const hasArtifact = Boolean(step.artifact_json)
  const hasMessage = Boolean(step.message)
  const expandable = hasArtifact || hasMessage

  return (
    <li>
      <button
        type="button"
        onClick={() => expandable && setOpen((o) => !o)}
        className={cn(
          "w-full flex items-start gap-3 px-4 py-3 text-left",
          expandable && "hover:bg-muted/40",
          !expandable && "cursor-default",
        )}
        aria-expanded={open}
      >
        <div
          className={cn(
            "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums",
            step.status === "completed" && "border-status-completed bg-status-completed text-primary-foreground",
            step.status === "running" && "border-status-running bg-status-running/15 text-status-running",
            step.status === "failed" && "border-status-terminal bg-status-terminal/15 text-status-terminal",
            step.status === "warning" && "border-status-waiting bg-status-waiting/15 text-status-waiting",
            step.status === "skipped" && "border-muted-foreground/40 bg-muted text-muted-foreground",
            step.status === "pending" && "border-border bg-card text-muted-foreground",
          )}
          aria-hidden
        >
          {step.step_num}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {expandable && (open
                ? <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden />
                : <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden />)}
              <span className="text-[13px] font-medium">{stepName}</span>
              <code className="font-mono text-xs text-muted-foreground">step_{step.step_num}</code>
              {step.attempt > 1 && (
                <code className="rounded bg-status-waiting/15 px-1 py-0.5 text-xs text-status-waiting">
                  attempt #{step.attempt}
                </code>
              )}
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={stPipeline} label={step.status} />
              <span className="font-mono text-xs tabular-nums text-muted-foreground">{dur}</span>
            </div>
          </div>
          {hasMessage && !open && (
            <div className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
              {step.message}
            </div>
          )}
        </div>
      </button>

      {open && expandable && (
        <div className="px-4 pb-4 pl-[3.25rem] flex flex-col gap-2">
          {hasMessage && (
            <div className="relative">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
                  Message
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); onCopy(step.message ?? "", "Message") }}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
                  title="Copy message"
                >
                  <Copy className="h-3 w-3" />
                </button>
              </div>
              <div
                className={cn(
                  "rounded px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words",
                  step.status === "failed"
                    ? "bg-status-terminal/10 text-status-terminal"
                    : step.status === "warning"
                      ? "bg-status-waiting/10 text-status-waiting"
                      : "bg-muted/60 text-foreground/80",
                )}
              >
                {step.message}
              </div>
            </div>
          )}

          {hasArtifact && (
            <div className="relative">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
                  Artifact
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); onCopy(step.artifact_json ?? "", "Artifact JSON") }}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
                  title="Copy artifact JSON"
                >
                  <Copy className="h-3 w-3" />
                </button>
              </div>
              <pre className="font-mono text-[11px] leading-relaxed bg-muted/40 rounded p-2.5 overflow-x-auto max-h-64">
                {(() => {
                  try { return JSON.stringify(JSON.parse(step.artifact_json ?? "{}"), null, 2) }
                  catch { return step.artifact_json ?? "" }
                })()}
              </pre>
            </div>
          )}

          {(step.status === "failed" || step.status === "warning" || step.status === "completed") && (
            <div className="flex gap-1.5 pt-1">
              <Button
                size="sm" variant="outline" className="h-7 gap-1 btn-soft-info"
                onClick={(e) => { e.stopPropagation(); onRetry() }}
                title={`Retry pipeline starting at step ${step.step_num}`}
              >
                <Play className="h-3 w-3" /> Retry from {step.step_num}
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  )
}
