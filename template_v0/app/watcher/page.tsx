"use client"

import * as React from "react"
import { Activity, Pause, Ban, RotateCw, ScrollText, Globe, ArrowUpRight } from "lucide-react"
import { AppShell } from "@/components/ssr/app-shell"
import { StatusBadge } from "@/components/ssr/status-badge"
import { PipelineProgress } from "@/components/ssr/pipeline-progress"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { MonoCode } from "@/components/ssr/data-table"
import { PIPELINE_STEPS, type PipelineStatus } from "@/lib/ssr/mock-data"
import { useDomains } from "@/hooks/use-domains"
import { useLogs } from "@/hooks/use-logs"
import { useDomainWatcher, useHeartbeat, useWatcher } from "@/hooks/use-watcher"
import { domainActions } from "@/lib/api-actions"
import { PIPELINE_STEPS as TAXONOMY_STEPS } from "@/lib/status-taxonomy"
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

export default function WatcherPage() {
  const { rows: domains } = useDomains()
  // Derive RUNS from non-success domains. The watcher needs to surface
  // anything that needs operator attention — including TERMINAL errors
  // (content_blocked / cf_pool_full / purchase_failed). Hiding those once
  // they hit a wall meant operators couldn't even see what to fix. Only
  // omit fully-successful (live / completed) and never-started (pending)
  // states from the active-runs sidebar.
  const RUNS: WatchedRun[] = domains
    .filter((d) =>
      d.status === "running" ||
      d.status === "waiting" ||
      d.status === "retryable_error" ||
      d.status === "terminal_error" ||
      d.status === "canceled",
    )
    .map((d, i) => ({
      pipelineId: `run-${d.id}`,
      domain: d.name,
      status: d.status,
      step: d.step || (d.status === "running" ? 5 : 0),
      server: d.server,
      ip: d.ip,
      startedAt: d.createdAt.split(" ")[1] ?? d.createdAt,
      elapsed: "—",
    }))

  const [activeId, setActiveId] = React.useState<string>("")
  const active: WatchedRun = RUNS.find((r) => r.pipelineId === activeId) ?? RUNS[0] ?? {
    pipelineId: "—",
    domain: "No active runs",
    status: "pending" as PipelineStatus,
    step: 0,
    server: "—",
    ip: "—",
    startedAt: "—",
    elapsed: "—",
  }
  const { events: LOG_EVENTS } = useLogs({
    domain: active?.domain ?? null,
    limit: 100,
  })
  const watchedDomain = active.domain && active.domain !== "No active runs" ? active.domain : null
  const { steps: liveSteps } = useDomainWatcher(watchedDomain)
  const { heartbeat } = useHeartbeat(watchedDomain)
  // Pull the full watcher snapshot so we can scan EVERY domain's steps for
  // ACTION REQUIRED markers (Flask templates/watcher.html line 84-91 — the
  // banner needs to fire even if the operator is looking at a different
  // domain in the sidebar).
  const { watcher: globalWatcher } = useWatcher(2000)
  const actionRequiredStep = (liveSteps ?? []).find(
    (s) => s.message && /ACTION\s*REQUIRED/i.test(s.message),
  )
  // Cross-domain scan: every domain's steps that match the marker. Filter out
  // the currently-selected one (already shown inline below) so the banner
  // surfaces alerts for OTHER domains the operator hasn't picked yet.
  const otherActionDomains: { domain: string; step_num: number; step_name: string; message: string }[] = []
  for (const [dom, steps] of Object.entries(globalWatcher?.watchers ?? {})) {
    if (dom === watchedDomain) continue
    for (const s of steps ?? []) {
      if (s.message && /ACTION\s*REQUIRED/i.test(s.message)) {
        otherActionDomains.push({
          domain: dom,
          step_num: s.step_num,
          step_name: s.step_name,
          message: s.message,
        })
      }
    }
  }
  const [busy, setBusy] = React.useState<"cancel" | "retry" | null>(null)
  const [actionMsg, setActionMsg] = React.useState<string>("")
  async function onCancel() {
    if (active.domain === "No active runs") return
    if (!confirm(
      `Cancel pipeline for ${active.domain}?\n\n` +
      `Cancel is GRACEFUL — the worker checks the cancel flag at each step boundary, ` +
      `so a long step (e.g., the 5–15 min SA agent install during step 6) finishes ` +
      `before the cancel takes effect.`,
    )) return
    setBusy("cancel"); setActionMsg("")
    const r = await domainActions.cancelPipeline(active.domain)
    setActionMsg(r.message ?? r.error ?? "")
    setBusy(null)
  }
  async function onRetryStep() {
    if (active.domain === "No active runs" || !active.step) return
    setBusy("retry"); setActionMsg("")
    const r = await domainActions.runFromStep(active.domain, active.step)
    setActionMsg(r.message ?? r.error ?? "")
    setBusy(null)
  }
  // Per-step "Run from here" — re-enqueues pipeline.full with start_from=N.
  // The pipeline's per-step skip logic re-runs N onward and short-circuits any
  // already-completed downstream work, so this is safe whether step N is
  // currently failed, warning, or completed (operator wants to redo from N).
  const [perStepBusy, setPerStepBusy] = React.useState<number | null>(null)
  async function onRunFromStep(stepNum: number) {
    if (active.domain === "No active runs") return
    setPerStepBusy(stepNum); setActionMsg("")
    const r = await domainActions.runFromStep(active.domain, stepNum)
    setActionMsg(r.message ?? r.error ?? `Run from step ${stepNum} requested`)
    setPerStepBusy(null)
  }

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
                    title={`View live progress for ${r.domain} — step ${r.step}/10, status ${r.status}`}
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
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="truncate text-base font-semibold tracking-tight">{active.domain}</h2>
                    <StatusBadge status={active.status} />
                    {/* Heartbeat chip — green if alive in last 5s, amber to 30s, red beyond */}
                    {heartbeat && watchedDomain && (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-micro font-medium",
                          heartbeat.alive && "border-status-completed/40 bg-status-completed/10 text-status-completed",
                          !heartbeat.alive && (heartbeat.seconds_ago ?? 999) <= 30 && "border-status-waiting/40 bg-status-waiting/10 text-status-waiting",
                          !heartbeat.alive && (heartbeat.seconds_ago ?? 999) > 30 && "border-status-terminal/40 bg-status-terminal/10 text-status-terminal",
                        )}
                        title={heartbeat.last_heartbeat_at ?? "no heartbeat yet"}
                      >
                        <span className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          heartbeat.alive && "bg-status-completed animate-pulse",
                          !heartbeat.alive && (heartbeat.seconds_ago ?? 999) <= 30 && "bg-status-waiting",
                          !heartbeat.alive && (heartbeat.seconds_ago ?? 999) > 30 && "bg-status-terminal",
                        )} aria-hidden />
                        {heartbeat.seconds_ago == null
                          ? "no heartbeat"
                          : heartbeat.alive
                            ? "live"
                            : `${heartbeat.seconds_ago}s ago`}
                      </span>
                    )}
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
              <div className="flex flex-col items-end gap-1">
                <ButtonGroup>
                  <Button
                    variant="outline" size="sm"
                    className="gap-1.5 btn-soft-info"
                    onClick={onRetryStep}
                    disabled={busy !== null || active.domain === "No active runs"}
                    title={
                      active.domain === "No active runs"
                        ? "Pick an active run from the sidebar first"
                        : `Re-run pipeline for ${active.domain} starting at step ${active.step}`
                    }
                  >
                    <RotateCw className="h-3.5 w-3.5" /> Retry step
                  </Button>
                  <Button
                    variant="outline" size="sm"
                    className="gap-1.5 btn-soft-destructive"
                    onClick={onCancel}
                    disabled={busy !== null || active.domain === "No active runs"}
                    title={
                      active.domain === "No active runs"
                        ? "Pick an active run from the sidebar first"
                        : `Cancel ${active.domain} — graceful, stops at next step boundary`
                    }
                  >
                    <Ban className="h-3.5 w-3.5" /> Cancel run
                  </Button>
                </ButtonGroup>
                {actionMsg && (
                  <span className="text-micro text-muted-foreground max-w-[280px] text-right">{actionMsg}</span>
                )}
              </div>
            </div>

            <div className="mt-5">
              <PipelineProgress currentStep={active.step} status={active.status} />
            </div>
          </div>

          {/* ACTION REQUIRED banner — yellow alert when any step's message
              contains the marker (e.g., a manual Turnstile click on a CF zone
              creation, or NS change at an external registrar). Mirrors Flask
              watcher.html's top banner — scans EVERY watched domain (lines
              84-91 in templates/watcher.html) so the operator sees alerts
              even for domains they haven't selected in the sidebar. */}
          {(actionRequiredStep || otherActionDomains.length > 0) && (
            <div
              role="alert"
              className="rounded-md border border-status-waiting/40 bg-status-waiting/10 px-4 py-3 text-small text-status-waiting"
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-status-waiting text-background">!</span>
                <div className="flex-1 min-w-0 flex flex-col gap-2">
                  {actionRequiredStep && (
                    <div>
                      <div className="font-semibold">
                        Action required at step {actionRequiredStep.step_num} — {actionRequiredStep.step_name}
                      </div>
                      <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-foreground/80">
                        {actionRequiredStep.message}
                      </p>
                    </div>
                  )}
                  {otherActionDomains.length > 0 && (
                    <div className={cn(actionRequiredStep && "pt-2 border-t border-status-waiting/30")}>
                      <div className="font-semibold">
                        Other domain{otherActionDomains.length === 1 ? "" : "s"} also needing action:
                      </div>
                      <ul className="mt-1 flex flex-col gap-1">
                        {otherActionDomains.slice(0, 5).map((row) => {
                          const id = `run-d_${row.domain}`
                          // Try to find the run id matching this domain in our
                          // RUNS list so clicking selects it directly. Falls
                          // back to a runtime lookup against the displayed runs.
                          const r = RUNS.find((x) => x.domain === row.domain)
                          return (
                            <li key={row.domain} className="break-words">
                              <button
                                type="button"
                                onClick={() => { if (r) setActiveId(r.pipelineId); else (void id) }}
                                className="text-left underline-offset-2 hover:underline font-mono text-[11px] text-foreground/85"
                                title={`Switch the watcher view to ${row.domain}`}
                                disabled={!r}
                              >
                                {row.domain}
                              </button>{" "}
                              <span className="text-foreground/70 font-mono text-[11px]">
                                · step {row.step_num} ({row.step_name}): {row.message}
                              </span>
                            </li>
                          )
                        })}
                        {otherActionDomains.length > 5 && (
                          <li className="text-[11px] text-foreground/70">
                            …and {otherActionDomains.length - 5} more
                          </li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Step detail list */}
          <div className="rounded-md border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 className="text-[13px] font-semibold tracking-tight">Step detail</h3>
              <span className="text-micro text-muted-foreground">10 steps total</span>
            </header>
            <ol className="divide-y divide-border">
              {(() => {
                // Build a render list of 10 rows, prefer real step_tracker
                // data when present, fall back to the taxonomy template so
                // the layout never collapses when the watcher hasn't loaded
                // yet (or when init_steps hasn't fired for this domain).
                const stepByNum = new Map<number, NonNullable<typeof liveSteps>[number]>()
                for (const r of liveSteps ?? []) stepByNum.set(r.step_num, r)
                return Array.from({ length: 10 }, (_, i) => i + 1).map((num) => {
                  const real = stepByNum.get(num)
                  const stepName = real?.step_name ?? TAXONOMY_STEPS[num]
                  const status = (real?.status ?? "pending") as
                    "pending" | "running" | "completed" | "failed" | "skipped" | "warning"
                  const message = real?.message ?? ""
                  const isCompleted = status === "completed"
                  const isFailed = status === "failed"
                  const isRunning = status === "running"
                  const isSkipped = status === "skipped"
                  const isWarning = status === "warning"
                  const isPending = status === "pending"

                  // Compute elapsed (from started_at → finished_at, or running)
                  let elapsed = ""
                  if (real?.started_at && real?.finished_at) {
                    const a = Date.parse((real.started_at as string).replace(" ", "T") + "Z")
                    const b = Date.parse((real.finished_at as string).replace(" ", "T") + "Z")
                    if (Number.isFinite(a) && Number.isFinite(b)) elapsed = `${Math.max(0, Math.round((b - a) / 1000))}s`
                  } else if (real?.started_at && isRunning) {
                    const a = Date.parse((real.started_at as string).replace(" ", "T") + "Z")
                    if (Number.isFinite(a)) elapsed = `${Math.max(0, Math.round((Date.now() - a) / 1000))}s`
                  }

                  // Map step_tracker status → PipelineStatus for the badge
                  const badge: PipelineStatus =
                    isCompleted ? "completed" :
                    isFailed ? "terminal_error" :
                    isRunning ? "running" :
                    isWarning ? "waiting" :
                    isSkipped ? "completed" :
                    "pending"

                  return (
                    <li key={num} className="flex items-start gap-3 px-4 py-3">
                      <div
                        className={cn(
                          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-micro font-semibold tabular-nums",
                          isCompleted && "border-status-completed bg-status-completed text-primary-foreground",
                          isRunning && "border-status-running bg-status-running/15 text-status-running",
                          isFailed && "border-status-terminal bg-status-terminal/15 text-status-terminal",
                          isWarning && "border-status-waiting bg-status-waiting/15 text-status-waiting",
                          isSkipped && "border-muted-foreground/40 bg-muted text-muted-foreground",
                          isPending && "border-border bg-card text-muted-foreground",
                        )}
                        aria-hidden
                      >
                        {num}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={cn(
                                "text-[13px] font-medium",
                                isPending && "text-muted-foreground",
                              )}
                            >
                              {stepName}
                            </span>
                            <code className="font-mono text-micro text-muted-foreground">step_{num}</code>
                            {isSkipped && (
                              <code className="rounded bg-muted px-1 text-micro text-muted-foreground">skipped</code>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <StatusBadge status={badge} />
                            <span className="font-mono text-micro tabular-nums text-muted-foreground">{elapsed}</span>
                            {/* Per-step "Run from here" — only on FAILED or WARNING
                                steps. Operators wanted retry-on-failure surface
                                area, not a button on every successful step too —
                                that just adds visual noise to a healthy pipeline. */}
                            {(isFailed || isWarning) && active.domain !== "No active runs" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 gap-1 px-1.5 text-micro"
                                onClick={() => onRunFromStep(num)}
                                disabled={perStepBusy === num}
                                title={`Re-run pipeline starting from step ${num} (${stepName})`}
                              >
                                <RotateCw className={cn("h-3 w-3", perStepBusy === num && "animate-spin")} />
                                Run from here
                              </Button>
                            )}
                          </div>
                        </div>
                        {message && (
                          <div
                            className={cn(
                              "mt-2 rounded px-2.5 py-2 font-mono text-[11px] leading-relaxed",
                              isFailed
                                ? "bg-status-terminal/10 text-status-terminal"
                                : isWarning
                                  ? "bg-status-waiting/10 text-status-waiting"
                                  : "bg-muted/60 text-foreground/80",
                            )}
                          >
                            {message}
                          </div>
                        )}
                      </div>
                    </li>
                  )
                })
              })()}
            </ol>
          </div>

          {/* Live log tail */}
          <div className="rounded-md border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <ScrollText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <h3 className="text-[13px] font-semibold tracking-tight">Live log</h3>
              </div>
              {watchedDomain ? (
                <a
                  href={`/logs?domain=${encodeURIComponent(watchedDomain)}`}
                  title={`Open the full Logs page filtered to ${watchedDomain}`}
                >
                  <Button variant="ghost" size="sm" className="h-7 gap-1 text-small">
                    Open in Logs <ArrowUpRight className="h-3 w-3" />
                  </Button>
                </a>
              ) : (
                <Button variant="ghost" size="sm" className="h-7 gap-1 text-small" disabled>
                  Open in Logs <ArrowUpRight className="h-3 w-3" />
                </Button>
              )}
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
