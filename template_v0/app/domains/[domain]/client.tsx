"use client"

import * as React from "react"
import {
  Globe,
  Server as ServerIcon,
  Cloud,
  Play,
  Ban,
  Trash2,
  RotateCw,
  Heart,
  Copy,
  ExternalLink,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { StatusBadge } from "@/components/ssr/status-badge"
import { PipelineProgress } from "@/components/ssr/pipeline-progress"
import { MonoCode } from "@/components/ssr/data-table"
import { useDomainWatcher, useHeartbeat } from "@/hooks/use-watcher"
import { useLogs } from "@/hooks/use-logs"
import { domainActions } from "@/lib/api-actions"
import { PIPELINE_STEPS as TAXONOMY_STEPS } from "@/lib/status-taxonomy"
import type { DomainRow } from "@/lib/repos/domains"
import type { ServerRow as ApiServerRow } from "@/lib/repos/servers"
import type { CfKeyWithPreview } from "@/lib/repos/cf-keys"
import type { StepTrackerRow } from "@/lib/repos/steps"
import type { PipelineLogRow } from "@/lib/repos/logs"
import type { PipelineStatus } from "@/lib/ssr/mock-data"
import { cn } from "@/lib/utils"

interface Props {
  domain: string
  row: DomainRow
  server: ApiServerRow | null
  cfKey: CfKeyWithPreview | null
  initialSteps: StepTrackerRow[]
  initialLogs: PipelineLogRow[]
}

const STATUS_TO_PIPELINE: Record<string, PipelineStatus> = {
  pending: "pending",
  purchased: "running",
  owned: "running",
  owned_external: "waiting",
  cf_assigned: "running",
  zone_created: "running",
  ns_set: "running",
  ns_pending_external: "waiting",
  zone_active: "running",
  app_created: "running",
  ssl_installed: "running",
  hosted: "completed",
  live: "live",
  canceled: "canceled",
  error: "retryable_error",
  retryable_error: "retryable_error",
  terminal_error: "terminal_error",
  content_blocked: "terminal_error",
  cf_pool_full: "terminal_error",
  manual_action_required: "waiting",
  waiting_dns: "waiting",
  ready_for_ssl: "running",
  ready_for_content: "running",
}

export function DomainDetailClient({ domain, row, server, cfKey, initialSteps, initialLogs }: Props) {
  // Live SWR — falls back to the SSR-rendered initial data so first paint
  // is instant and the page hydrates with fresher data after a tick.
  const { steps: liveSteps } = useDomainWatcher(domain)
  const { heartbeat } = useHeartbeat(domain)
  const { events: liveLogs } = useLogs({ domain, limit: 50 })

  const steps = liveSteps ?? initialSteps
  const logs = liveLogs.length > 0 ? liveLogs : initialLogs.map((l) => ({
    id: String(l.id), ts: l.created_at, level: ("info" as const),
    domain: l.domain, step: l.step, message: l.message ?? "", pipeline: `p_${l.id}`,
  }))

  const currentStep = (() => {
    const running = steps.find((s) => s.status === "running")
    if (running) return running.step_num
    const completed = steps.filter((s) => s.status === "completed" || s.status === "skipped").length
    return Math.max(1, Math.min(10, completed))
  })()
  const status: PipelineStatus = STATUS_TO_PIPELINE[row.status] ?? "pending"

  // ----- Action panel -----
  const [busy, setBusy] = React.useState<string | null>(null)
  const [flash, setFlash] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)
  function show(kind: "ok" | "err", text: string) {
    setFlash({ kind, text })
    window.setTimeout(() => setFlash(null), 5500)
  }
  async function runPipeline() {
    if (!confirm(`Run pipeline for ${domain}?`)) return
    setBusy("run")
    const r = await domainActions.runPipeline(domain)
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
    setBusy(null)
  }
  async function retryStep() {
    setBusy("retry")
    const r = await domainActions.runFromStep(domain, currentStep)
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
    setBusy(null)
  }
  // Per-step "Run from here" — same primitive as the watcher page's per-row
  // button. Re-enqueues pipeline.full with start_from=N; smart-resume short-
  // circuits already-completed upstream work, so safe at any boundary.
  const [perStepBusy, setPerStepBusy] = React.useState<number | null>(null)
  async function onRunFromStep(stepNum: number) {
    setPerStepBusy(stepNum)
    const r = await domainActions.runFromStep(domain, stepNum)
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? `Run from step ${stepNum} requested`)
    setPerStepBusy(null)
  }
  async function cancelPipeline() {
    if (!confirm(
      `Cancel pipeline for ${domain}?\n\n` +
      `Cancel is GRACEFUL — the worker checks the cancel flag at each step boundary.`,
    )) return
    setBusy("cancel")
    const r = await domainActions.cancelPipeline(domain)
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
    setBusy(null)
  }
  async function softDelete() {
    if (!confirm(
      `Remove ${domain} from dashboard ONLY?\n\n` +
      `The SA app, CF zone, and Spaceship record stay intact.`,
    )) return
    setBusy("delete")
    const r = await domainActions.delete(domain)
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
    if (r.ok) window.location.assign("/domains")
    setBusy(null)
  }

  function copy(value: string, label: string) {
    if (!value) return
    navigator.clipboard?.writeText(value).then(
      () => show("ok", `${label} copied`),
      () => show("err", "Copy failed"),
    )
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

      {/* ===== Header card ===== */}
      <section className="rounded-md border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
              <Globe className="h-5 w-5 text-muted-foreground" aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="truncate text-lg font-semibold tracking-tight font-mono">{domain}</h2>
                <StatusBadge status={status} />
                {/* Heartbeat chip — tracks live polling */}
                {heartbeat && (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs font-medium",
                      heartbeat.alive && "border-status-completed/40 bg-status-completed/10 text-status-completed",
                      !heartbeat.alive && (heartbeat.seconds_ago ?? 999) <= 30 && "border-status-waiting/40 bg-status-waiting/10 text-status-waiting",
                      !heartbeat.alive && (heartbeat.seconds_ago ?? 999) > 30 && "border-status-terminal/40 bg-status-terminal/10 text-status-terminal",
                    )}
                    title={heartbeat.last_heartbeat_at ?? "no heartbeat yet"}
                  >
                    <Heart className="h-3 w-3" aria-hidden />
                    {heartbeat.seconds_ago == null
                      ? "no heartbeat"
                      : heartbeat.alive
                        ? "live"
                        : `${heartbeat.seconds_ago}s ago`}
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>step {currentStep} / 10</span>
                <span>·</span>
                <span>created {row.created_at}</span>
                <span>·</span>
                <span>updated {row.updated_at}</span>
              </div>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <ButtonGroup>
              <Button
                size="sm" className="gap-1.5 btn-success"
                onClick={runPipeline} disabled={busy !== null}
                title="Run the full pipeline (smart-resume — auto-detects completed steps)"
              >
                <Play className="h-3.5 w-3.5" /> Run pipeline
              </Button>
              <Button
                size="sm" variant="outline" className="gap-1.5 btn-soft-info"
                onClick={retryStep} disabled={busy !== null}
                title={`Re-run pipeline starting at step ${currentStep}`}
              >
                <RotateCw className="h-3.5 w-3.5" /> Retry step {currentStep}
              </Button>
              <Button
                size="sm" variant="outline" className="gap-1.5 btn-soft-warning"
                onClick={cancelPipeline} disabled={busy !== null}
                title="Cancel — graceful, stops at next step boundary"
              >
                <Ban className="h-3.5 w-3.5" /> Cancel
              </Button>
              <Button
                size="sm" variant="outline" className="gap-1.5 btn-soft-destructive"
                onClick={softDelete} disabled={busy !== null}
                title="Soft delete — remove from dashboard only (services keep running)"
              >
                <Trash2 className="h-3.5 w-3.5" /> Soft delete
              </Button>
            </ButtonGroup>
          </div>
        </header>

        {/* Pipeline progress strip */}
        <div className="px-5 py-4">
          <PipelineProgress currentStep={currentStep} status={status} />
        </div>
      </section>

      {/* ===== Resource grid: server, CF, DNS ===== */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Server card */}
        <ResourceCard
          title="Server"
          icon={ServerIcon}
          accent="var(--page-servers)"
          empty={!server}
          emptyHint="No server assigned yet — pipeline step 6 picks one."
        >
          {server && (
            <dl className="flex flex-col gap-1.5 text-small">
              <Row label="Name">
                <code className="font-mono">{server.name ?? "—"}</code>
              </Row>
              <Row label="IP" copyable={server.ip ?? ""} onCopy={copy}>
                <MonoCode>{server.ip ?? "—"}</MonoCode>
              </Row>
              <Row label="DO ID" copyable={server.do_droplet_id ?? ""} onCopy={copy}>
                <code className="font-mono text-xs text-muted-foreground">
                  {server.do_droplet_id ?? "—"}
                </code>
              </Row>
              <Row label="SA ID" copyable={server.sa_server_id ?? ""} onCopy={copy}>
                <code className="font-mono text-xs text-muted-foreground">
                  {server.sa_server_id ?? "—"}
                </code>
              </Row>
              <Row label="Region">
                <span className="font-mono uppercase text-xs">{server.region ?? "—"}</span>
              </Row>
              <Row label="Sites">
                <span className="font-mono text-xs">{server.sites_count}/{server.max_sites}</span>
              </Row>
            </dl>
          )}
        </ResourceCard>

        {/* CF card */}
        <ResourceCard
          title="Cloudflare"
          icon={Cloud}
          accent="var(--page-cloudflare)"
          empty={!cfKey && !row.cf_email}
          emptyHint="No CF key assigned — pipeline step 2 picks one from the pool."
          actions={
            row.cf_zone_id ? (
              <a
                href={`https://dash.cloudflare.com/?to=/:account/${row.cf_account_id ?? ""}/${domain}`}
                target="_blank" rel="noopener noreferrer"
                title="Open this zone in the Cloudflare dashboard"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" /> Open in CF
              </a>
            ) : undefined
          }
        >
          <dl className="flex flex-col gap-1.5 text-small">
            <Row label="Pool key">
              {cfKey ? (
                <code className="font-mono">{cfKey.alias || `CF#${cfKey.id}`}</code>
              ) : (
                <span className="text-muted-foreground">none</span>
              )}
            </Row>
            <Row label="Email">
              <span className="font-mono text-xs text-muted-foreground">{row.cf_email || "—"}</span>
            </Row>
            <Row label="Zone ID" copyable={row.cf_zone_id ?? ""} onCopy={copy}>
              <code className="font-mono text-xs text-muted-foreground">
                {row.cf_zone_id ?? "—"}
              </code>
            </Row>
            <Row label="Account ID" copyable={row.cf_account_id ?? ""} onCopy={copy}>
              <code className="font-mono text-xs text-muted-foreground">
                {row.cf_account_id ?? "—"}
              </code>
            </Row>
          </dl>
        </ResourceCard>

        {/* DNS / NS card */}
        <ResourceCard
          title="DNS"
          icon={Globe}
          accent="var(--page-domains)"
          empty={!row.cf_nameservers && !row.current_proxy_ip}
          emptyHint="No DNS data yet — populated after CF zone creation (step 3)."
        >
          <dl className="flex flex-col gap-1.5 text-small">
            <Row label="A record" copyable={row.current_proxy_ip ?? ""} onCopy={copy}>
              <MonoCode>{row.current_proxy_ip ?? "—"}</MonoCode>
            </Row>
            <Row label="apex record">
              <code className="font-mono text-xs text-muted-foreground">{row.cf_a_record_id ?? "—"}</code>
            </Row>
            <Row label="www record">
              <code className="font-mono text-xs text-muted-foreground">{row.cf_www_record_id ?? "—"}</code>
            </Row>
            <Row label="Nameservers" copyable={row.cf_nameservers ?? ""} onCopy={copy}>
              <span className="font-mono text-xs break-all text-muted-foreground">
                {row.cf_nameservers ?? "—"}
              </span>
            </Row>
          </dl>
          {row.cf_nameservers && (
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground/80">
              Cloudflare assigns the same NS pair to every zone in one account, so other
              SSR domains on this CF key will share these nameservers. Verify a unique
              zone via the <strong>Zone ID</strong> in the Cloudflare card above —
              that's the per-domain identifier.
            </p>
          )}
        </ResourceCard>
      </section>

      {/* ===== Pipeline timeline ===== */}
      <section className="rounded-md border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h3 className="text-[13px] font-semibold tracking-tight">Pipeline timeline</h3>
          <span className="text-xs text-muted-foreground">10 steps</span>
        </header>
        <ol className="divide-y divide-border">
          {(() => {
            const byNum = new Map(steps.map((s) => [s.step_num, s]))
            return Array.from({ length: 10 }, (_, i) => i + 1).map((num) => {
              const s = byNum.get(num)
              const stepName = s?.step_name ?? TAXONOMY_STEPS[num]
              const st = (s?.status ?? "pending") as
                "pending" | "running" | "completed" | "failed" | "skipped" | "warning"
              let elapsed = ""
              if (s?.started_at && s?.finished_at) {
                const a = Date.parse(s.started_at.replace(" ", "T") + "Z")
                const b = Date.parse(s.finished_at.replace(" ", "T") + "Z")
                if (Number.isFinite(a) && Number.isFinite(b)) {
                  elapsed = `${Math.max(0, Math.round((b - a) / 1000))}s`
                }
              } else if (s?.started_at && st === "running") {
                const a = Date.parse(s.started_at.replace(" ", "T") + "Z")
                if (Number.isFinite(a)) {
                  elapsed = `${Math.max(0, Math.round((Date.now() - a) / 1000))}s`
                }
              }
              return (
                <li key={num} className="flex items-start gap-3 px-4 py-3">
                  <div
                    className={cn(
                      "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums",
                      st === "completed" && "border-status-completed bg-status-completed text-primary-foreground",
                      st === "running" && "border-status-running bg-status-running/15 text-status-running",
                      st === "failed" && "border-status-terminal bg-status-terminal/15 text-status-terminal",
                      st === "warning" && "border-status-waiting bg-status-waiting/15 text-status-waiting",
                      st === "skipped" && "border-muted-foreground/40 bg-muted text-muted-foreground",
                      st === "pending" && "border-border bg-card text-muted-foreground",
                    )}
                    aria-hidden
                  >
                    {num}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className={cn("text-[13px] font-medium", st === "pending" && "text-muted-foreground")}>
                        {stepName}
                      </span>
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-xs text-muted-foreground">step_{num}</code>
                        {elapsed && (
                          <span className="font-mono text-xs tabular-nums text-muted-foreground">{elapsed}</span>
                        )}
                        {st !== "running" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 gap-1 px-1.5 text-xs"
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
                    {s?.message && (
                      <div
                        className={cn(
                          "mt-2 rounded px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words",
                          st === "failed"
                            ? "bg-status-terminal/10 text-status-terminal"
                            : st === "warning"
                              ? "bg-status-waiting/10 text-status-waiting"
                              : "bg-muted/60 text-foreground/80",
                        )}
                      >
                        {s.message}
                      </div>
                    )}
                  </div>
                </li>
              )
            })
          })()}
        </ol>
      </section>

      {/* ===== Log tail ===== */}
      <section className="rounded-md border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h3 className="text-[13px] font-semibold tracking-tight">Recent log entries</h3>
          <a
            href={`/logs?domain=${encodeURIComponent(domain)}`}
            className="text-xs text-muted-foreground hover:text-foreground"
            title="Open the full Logs page filtered to this domain"
          >
            Open in Logs →
          </a>
        </header>
        <div className="max-h-[320px] overflow-y-auto p-3 font-mono text-[11.5px] leading-relaxed">
          {logs.length === 0 && (
            <span className="text-xs text-muted-foreground">No log entries yet.</span>
          )}
          {logs.slice(0, 50).map((l) => (
            <div key={l.id} className="flex items-start gap-2 py-0.5">
              <span className="text-muted-foreground/60 tabular-nums">{l.ts.split(" ")[1] ?? l.ts}</span>
              <span
                className={cn(
                  "uppercase font-semibold w-12 shrink-0",
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
      </section>
    </div>
  )
}

function ResourceCard({
  title, icon: Icon, accent, empty, emptyHint, actions, children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  accent: string
  empty?: boolean
  emptyHint?: string
  actions?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="rounded-md border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5" style={{ color: accent }} />
          <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
        </div>
        {actions}
      </header>
      <div className="px-4 py-3">
        {empty ? (
          <p className="text-xs text-muted-foreground">{emptyHint}</p>
        ) : (
          children
        )}
      </div>
    </div>
  )
}

function Row({
  label, children, copyable, onCopy,
}: {
  label: string
  children: React.ReactNode
  copyable?: string
  onCopy?: (value: string, label: string) => void
}) {
  return (
    <div className="flex items-start justify-between gap-2 group">
      <dt className="text-xs text-muted-foreground min-w-[80px] shrink-0">{label}</dt>
      <dd className="flex-1 min-w-0 text-right break-all flex items-center justify-end gap-1.5">
        {children}
        {copyable && onCopy && (
          <button
            type="button"
            onClick={() => onCopy(copyable, label)}
            className="opacity-0 group-hover:opacity-100 transition-opacity rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
            aria-label={`Copy ${label}`}
            title={`Copy ${label}`}
          >
            <Copy className="h-3 w-3" />
          </button>
        )}
      </dd>
    </div>
  )
}
