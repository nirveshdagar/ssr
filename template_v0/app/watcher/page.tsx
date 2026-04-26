"use client"

import * as React from "react"
import { Activity, Pause, Ban, RotateCw, ScrollText, Globe, ArrowUpRight } from "lucide-react"
import { AppShell } from "@/components/ssr/app-shell"
import { StatusBadge } from "@/components/ssr/status-badge"
import { PipelineProgress } from "@/components/ssr/pipeline-progress"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { MonoCode } from "@/components/ssr/data-table"
import { DOMAINS, PIPELINE_STEPS, LOG_EVENTS, type PipelineStatus } from "@/lib/ssr/mock-data"
import { cn } from "@/lib/utils"

type WatchedRun = {
  pipelineId: string
  domain: string
  status: PipelineStatus
  step: number
  server: string
  ip: string
  startedAt: string
  elapsed: string
}

const RUNS: WatchedRun[] = [
  { pipelineId: "p_8821", domain: "northbeam.dev",   status: "running",         step: 7, server: "do-sfo3-02", ip: "143.198.74.12", startedAt: "10:18:42", elapsed: "5m 36s" },
  { pipelineId: "p_8820", domain: "quietharbor.app", status: "running",         step: 4, server: "do-ams3-01", ip: "—",             startedAt: "10:20:14", elapsed: "4m 04s" },
  { pipelineId: "p_8819", domain: "fernpath.co",     status: "waiting",         step: 5, server: "do-nyc3-03", ip: "—",             startedAt: "10:21:01", elapsed: "3m 17s" },
  { pipelineId: "p_8815", domain: "boldmeridian.net",status: "retryable_error", step: 6, server: "do-sfo3-02", ip: "143.198.74.18", startedAt: "10:11:30", elapsed: "12m 48s" },
]

export default function WatcherPage() {
  const [activeId, setActiveId] = React.useState<string>(RUNS[0].pipelineId)
  const active = RUNS.find((r) => r.pipelineId === activeId)!

  return (
    <AppShell
      title="Watcher"
      description="Live step-by-step progress for active pipelines"
      breadcrumbs={[{ label: "Watcher" }]}
      accent="watcher"
      actions={
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-micro text-muted-foreground">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-status-running opacity-70 animate-status-pulse" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-status-running" />
          </span>
          Live · auto-refresh 2s
        </span>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-3">
        {/* Run list */}
        <aside className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between px-1">
            <span className="text-micro font-medium uppercase tracking-wider text-muted-foreground">
              Active runs
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-micro font-medium tabular-nums text-muted-foreground">
              {RUNS.length}
            </span>
          </div>
          <ul className="flex flex-col gap-1">
            {RUNS.map((r) => {
              const isActive = activeId === r.pipelineId
              return (
                <li key={r.pipelineId}>
                  <button
                    onClick={() => setActiveId(r.pipelineId)}
                    className={cn(
                      "w-full text-left rounded-md border p-3 transition-colors",
                      isActive
                        ? "border-primary/40 bg-primary/5"
                        : "border-border bg-card hover:border-foreground/20",
                    )}
                    aria-current={isActive ? "true" : undefined}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px] font-semibold">{r.domain}</span>
                      <StatusBadge status={r.status} />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-micro text-muted-foreground">
                      <span className="font-mono">{r.pipelineId}</span>
                      <span className="font-mono tabular-nums">
                        Step {r.step}/10
                      </span>
                    </div>
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all",
                          r.status === "retryable_error" ? "bg-status-retryable" : "bg-primary",
                        )}
                        style={{ width: `${(r.step / 10) * 100}%` }}
                      />
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        </aside>

        {/* Detail */}
        <section className="flex flex-col gap-3 min-w-0">
          {/* Header card */}
          <div className="rounded-md border border-border bg-card p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Globe className="h-4 w-4 text-muted-foreground" aria-hidden />
                </div>
                <div className="flex flex-col min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-semibold tracking-tight">{active.domain}</h2>
                    <StatusBadge status={active.status} />
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted-foreground">
                    <span className="font-mono">{active.pipelineId}</span>
                    <span>·</span>
                    <span>
                      Server <MonoCode>{active.server}</MonoCode>
                    </span>
                    <span>·</span>
                    <span>
                      IP <MonoCode>{active.ip}</MonoCode>
                    </span>
                    <span>·</span>
                    <span>Started {active.startedAt}</span>
                    <span>·</span>
                    <span className="tabular-nums">Elapsed {active.elapsed}</span>
                  </div>
                </div>
              </div>
              <ButtonGroup>
                <Button variant="outline" size="sm" className="gap-1.5 btn-soft-warning">
                  <Pause className="h-3.5 w-3.5" /> Pause
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5 btn-soft-info">
                  <RotateCw className="h-3.5 w-3.5" /> Retry step
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5 btn-soft-destructive">
                  <Ban className="h-3.5 w-3.5" /> Cancel run
                </Button>
              </ButtonGroup>
            </div>

            <div className="mt-5">
              <PipelineProgress currentStep={active.step} status={active.status} />
            </div>
          </div>

          {/* Step detail list */}
          <div className="rounded-md border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 className="text-[13px] font-semibold tracking-tight">Step detail</h3>
              <span className="text-micro text-muted-foreground">10 steps total</span>
            </header>
            <ol className="divide-y divide-border">
              {PIPELINE_STEPS.map((step) => {
                const isCompleted = step.id < active.step
                const isCurrent = step.id === active.step
                const isFailed = isCurrent && (active.status === "retryable_error" || active.status === "terminal_error")
                const isWaiting = isCurrent && active.status === "waiting"
                const isPending = step.id > active.step

                let stepStatus: PipelineStatus = "pending"
                if (isCompleted) stepStatus = "completed"
                else if (isFailed) stepStatus = active.status
                else if (isWaiting) stepStatus = "waiting"
                else if (isCurrent) stepStatus = "running"

                return (
                  <li key={step.id} className="flex items-start gap-3 px-4 py-3">
                    <div
                      className={cn(
                        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-micro font-semibold tabular-nums",
                        isCompleted && "border-status-completed bg-status-completed text-primary-foreground",
                        isCurrent && !isFailed && "border-status-running bg-status-running/15 text-status-running",
                        isFailed && "border-status-terminal bg-status-terminal/15 text-status-terminal",
                        isPending && "border-border bg-card text-muted-foreground",
                      )}
                      aria-hidden
                    >
                      {step.id}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "text-[13px] font-medium",
                              isPending && "text-muted-foreground",
                            )}
                          >
                            {step.label}
                          </span>
                          <code className="font-mono text-micro text-muted-foreground">{step.key}</code>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={stepStatus} />
                          <span className="font-mono text-micro tabular-nums text-muted-foreground">
                            {isCompleted ? `${20 + step.id * 7}s` : isCurrent ? "—" : ""}
                          </span>
                        </div>
                      </div>
                      {(isCurrent || isFailed) && (
                        <div className="mt-2 rounded bg-muted/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/80">
                          {isFailed
                            ? `[error] ${step.key} failed; retry 1/3 scheduled in 30s`
                            : `[info] ${step.key} in progress — awaiting upstream response`}
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          </div>

          {/* Live log tail */}
          <div className="rounded-md border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <ScrollText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <h3 className="text-[13px] font-semibold tracking-tight">Live log</h3>
              </div>
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-small">
                Open in Logs <ArrowUpRight className="h-3 w-3" />
              </Button>
            </header>
            <div className="max-h-[280px] overflow-y-auto p-3 font-mono text-[11.5px] leading-relaxed">
              {LOG_EVENTS.slice(0, 10).map((l) => (
                <div key={l.id} className="flex items-start gap-2 py-0.5">
                  <span className="text-muted-foreground/60 tabular-nums">{l.ts.split(" ")[1]}</span>
                  <span
                    className={cn(
                      "uppercase font-semibold w-10 shrink-0",
                      l.level === "info" && "text-status-running",
                      l.level === "warn" && "text-status-waiting",
                      l.level === "error" && "text-status-terminal",
                      l.level === "debug" && "text-muted-foreground",
                    )}
                  >
                    {l.level}
                  </span>
                  <span className="text-muted-foreground">[{l.step}]</span>
                  <span className="flex-1 text-foreground/85 break-words">{l.message}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  )
}
