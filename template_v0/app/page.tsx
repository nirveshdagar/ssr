"use client"

import {
  Globe,
  Server as ServerIcon,
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Plus,
  RefreshCw,
} from "lucide-react"
import { AppShell } from "@/components/ssr/app-shell"
import { KpiTile, KpiTileSkeleton } from "@/components/ssr/kpi-tile"
import { StatusBadge } from "@/components/ssr/status-badge"
import { PipelineProgress } from "@/components/ssr/pipeline-progress"
import { Button } from "@/components/ui/button"
import {
  DataTableShell,
  DataTable,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  DataTableCell,
  MonoCode,
} from "@/components/ssr/data-table"
import { useDomains } from "@/hooks/use-domains"
import { useAudit } from "@/hooks/use-audit"
import { useServers } from "@/hooks/use-servers"
import { useCfKeys } from "@/hooks/use-cf-keys"
import { useStatus } from "@/hooks/use-status"
import { domainActions } from "@/lib/api-actions"
import { cn } from "@/lib/utils"

export default function DashboardPage() {
  const { rows: DOMAINS, isLoading: domainsLoading } = useDomains()
  const { rows: auditRows } = useAudit({ page: 1 })
  const { rows: SERVERS } = useServers()
  const { rows: CF_KEYS } = useCfKeys()
  const { status: liveStatus } = useStatus(5000)
  // First-paint guard for the KPI tiles — show skeletons while the four
  // primary fetches are still warming up so the layout doesn't pop in.
  const dataWarming = domainsLoading || (DOMAINS.length === 0 && SERVERS.length === 0 && !liveStatus)
  const activeWatchers = liveStatus?.active_watchers ?? []
  // An "active run" is any domain whose worker has heart-beat in the last 5s.
  // Falls back to in-flight statuses while live data warms up.
  const activeRuns = DOMAINS.filter(
    (d) => activeWatchers.includes(d.name) || d.status === "running" || d.status === "waiting",
  ).slice(0, 3)
  const liveCount = DOMAINS.filter((d) => d.status === "live").length
  const errorCount24h = auditRows.filter(
    (a) => /fail|error|blocked/i.test(a.action) && Date.parse(a.ts) > Date.now() - 24 * 3600 * 1000,
  ).length
  const healthyServers = SERVERS.filter((s) => s.status === "active").length
  const deadServers = SERVERS.filter((s) => s.status === "dead").length
  // Derive a small activity feed from the most recent audit rows so the
  // dashboard stays alive even without a dedicated /api/activity endpoint.
  const ACTIVITY_FEED = auditRows.slice(0, 8).map((a) => ({
    id: a.id,
    ts: a.ts.split(" ")[1]?.slice(0, 5) ?? "",
    text: `${a.action}${a.target ? " — " + a.target : ""}${a.detail ? ": " + a.detail : ""}`,
    kind: (a.action.includes("delete") || a.action.includes("fail")
      ? "error"
      : a.action.includes("login_ok") || a.action.includes("create")
      ? "success"
      : "info") as "info" | "success" | "error" | "warning",
  }))

  return (
    <AppShell
      title="Dashboard"
      description="Pipeline health and recent operator activity"
      accent="dashboard"
      actions={
        <>
          <Button
            variant="outline" size="sm"
            className="gap-1.5 hidden sm:inline-flex btn-soft-info"
            onClick={() => window.location.reload()}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Sync
          </Button>
          <Button
            size="sm" className="gap-1.5 btn-success"
            onClick={async () => {
              const v = window.prompt("Domain to run pipeline on:")?.trim()
              if (!v) return
              const r = await domainActions.runPipeline(v)
              window.alert(r.message ?? r.error ?? "submitted")
            }}
          >
            <Plus className="h-3.5 w-3.5" /> New pipeline
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {/* Quick Actions card — 5 nav shortcuts. Mirrors templates/dashboard.html lines 31-44. */}
        <section
          aria-label="Quick actions"
          className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2"
        >
          {[
            { href: "/domains",    label: "Domains",    Icon: Globe,       color: "var(--page-domains)" },
            { href: "/servers",    label: "Servers",    Icon: ServerIcon,  color: "var(--page-servers)" },
            { href: "/cloudflare", label: "Cloudflare", Icon: Cloud,       color: "var(--page-cloudflare)" },
            { href: "/watcher",    label: "Watcher",    Icon: Activity,    color: "var(--page-watcher)" },
            { href: "/logs",       label: "Logs",       Icon: AlertTriangle, color: "var(--page-logs)" },
          ].map(({ href, label, Icon, color }) => (
            <a
              key={href}
              href={href}
              className="group flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2.5 transition-colors hover:border-foreground/20"
            >
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors"
                style={{
                  backgroundColor: `color-mix(in oklch, ${color} 12%, transparent)`,
                  color,
                }}
              >
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="flex flex-col leading-tight min-w-0">
                <span className="text-[13px] font-semibold tracking-tight">{label}</span>
                <span className="text-micro text-muted-foreground">Open {label.toLowerCase()}</span>
              </span>
            </a>
          ))}
        </section>

        {/* KPI grid */}
        <section aria-label="Key metrics" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {dataWarming ? (
            <>
              <KpiTileSkeleton />
              <KpiTileSkeleton />
              <KpiTileSkeleton />
              <KpiTileSkeleton />
            </>
          ) : <>
          <KpiTile
            label="Live domains"
            value={String(liveCount)}
            change={{ value: `${DOMAINS.length} total`, direction: "flat" }}
            icon={Globe}
            accent="success"
          />
          <KpiTile
            label="Active pipelines"
            value={String(activeWatchers.length)}
            change={{ value: `${DOMAINS.filter((d) => d.status === "waiting").length} waiting`, direction: "flat" }}
            icon={Activity}
            accent="info"
          />
          <KpiTile
            label="Healthy servers"
            value={`${healthyServers} / ${SERVERS.length}`}
            change={{
              value: deadServers > 0 ? `${deadServers} dead` : "all active",
              direction: deadServers > 0 ? "down" : "flat",
              positive: deadServers === 0,
            }}
            icon={ServerIcon}
            // Yellow when healthy, escalates to destructive orange-red on dead-flip.
            accent={deadServers > 0 ? "danger" : "warning"}
          />
          <KpiTile
            label="Errors (24h)"
            value={String(errorCount24h)}
            change={{ value: errorCount24h === 0 ? "none" : "from audit log", direction: "flat" }}
            icon={AlertTriangle}
            accent={errorCount24h > 0 ? "danger" : "success"}
          />
          </>}
        </section>

        {/* Two-up: active runs + activity */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Active runs */}
          <div className="lg:col-span-2 rounded-md border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-semibold tracking-tight">Active pipelines</h2>
                <span className="rounded bg-muted px-1.5 py-0.5 text-micro font-medium tabular-nums text-muted-foreground">
                  {activeRuns.length}
                </span>
              </div>
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-small">
                Open watcher
              </Button>
            </header>
            <ul className="divide-y divide-border">
              {activeRuns.map((d) => (
                <li key={d.id} className="px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted">
                        <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      </div>
                      <div className="flex flex-col min-w-0 leading-tight">
                        <span className="truncate text-[13px] font-semibold">{d.name}</span>
                        <span className="text-micro text-muted-foreground">
                          {d.server} · <MonoCode>{d.ip}</MonoCode>
                        </span>
                      </div>
                    </div>
                    <StatusBadge status={d.status} />
                  </div>
                  <div className="mt-3">
                    <PipelineProgress currentStep={d.step} status={d.status} compact />
                    <div className="mt-2 flex items-center justify-between text-micro text-muted-foreground">
                      <span>
                        Step {d.step} of 10 · started {d.createdAt.split(" ")[1]}
                      </span>
                      <span>p_{Math.floor(8800 + parseInt(d.id.replace("d_", "")))}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {/* Activity feed */}
          <div className="rounded-md border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="text-[13px] font-semibold tracking-tight">Recent activity</h2>
              <Button variant="ghost" size="sm" className="h-7 text-small">
                View all
              </Button>
            </header>
            <ol className="divide-y divide-border">
              {ACTIVITY_FEED.map((a) => (
                <li key={a.id} className="flex items-start gap-2.5 px-4 py-2.5">
                  <span
                    className={cn(
                      "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                      a.kind === "info" && "bg-status-running",
                      a.kind === "success" && "bg-status-completed",
                      a.kind === "warning" && "bg-status-waiting",
                      a.kind === "error" && "bg-status-terminal",
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] leading-snug text-foreground/90 break-words">{a.text}</p>
                    <span className="font-mono text-micro text-muted-foreground">{a.ts}</span>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Capacity / pool snapshot */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="rounded-md border border-border bg-card p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-[13px] font-semibold tracking-tight">Server capacity</h2>
                <p className="mt-0.5 text-micro text-muted-foreground">
                  Domains hosted across active droplets
                </p>
              </div>
              <ServerIcon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="mt-4 space-y-2.5">
              {SERVERS.length === 0 && (
                <div className="text-micro text-muted-foreground py-2">
                  No servers yet. Add one from the Servers page.
                </div>
              )}
              {SERVERS.slice(0, 8).map((s) => {
                const pct = s.capacity > 0 ? Math.round((s.domains / s.capacity) * 100) : 0
                const danger = pct >= 95 || s.status === "dead"
                const warn = pct >= 75
                return (
                  <div key={s.id} className="flex items-center gap-3">
                    <div className="w-28 min-w-0">
                      <div className="truncate text-[12px] font-medium">{s.name}</div>
                      <div className="text-micro text-muted-foreground">
                        {s.region}{s.status === "dead" ? " · dead" : ""}
                      </div>
                    </div>
                    <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          danger ? "bg-status-terminal" : warn ? "bg-status-waiting" : "bg-primary",
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="w-16 shrink-0 text-right font-mono text-micro tabular-nums text-muted-foreground">
                      {s.domains}/{s.capacity}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="rounded-md border border-border bg-card p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-[13px] font-semibold tracking-tight">Cloudflare pool</h2>
                <p className="mt-0.5 text-micro text-muted-foreground">
                  Rate limit usage across pooled API keys
                </p>
              </div>
              <Cloud className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="mt-4 space-y-2.5">
              {CF_KEYS.length === 0 && (
                <div className="text-micro text-muted-foreground py-2">
                  No CF keys yet. Add one from the Cloudflare page.
                </div>
              )}
              {CF_KEYS.slice(0, 8).map((k) => (
                <div key={k.id} className="flex items-center gap-3">
                  <div className="w-28 min-w-0">
                    <div className="truncate text-[12px] font-medium">{k.label}</div>
                    <div className="text-micro text-muted-foreground">cf-{k.id}</div>
                  </div>
                  <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        k.status === "exhausted" && "bg-status-terminal",
                        k.status === "warning" && "bg-status-waiting",
                        k.status === "healthy" && "bg-primary",
                      )}
                      style={{ width: `${k.rateLimitUsed}%` }}
                    />
                  </div>
                  <div className="w-12 text-right font-mono text-micro tabular-nums text-muted-foreground">
                    {k.rateLimitUsed}%
                  </div>
                  <StatusBadge status={k.status} />
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Most recent domains snapshot */}
        <section>
          <DataTableShell>
            <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
              <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-semibold tracking-tight">Latest domains</h2>
                <span className="rounded bg-muted px-1.5 py-0.5 text-micro font-medium tabular-nums text-muted-foreground">
                  Last 10
                </span>
              </div>
              <Button variant="ghost" size="sm" className="h-7 text-small">
                View all
              </Button>
            </header>
            <DataTable>
              <DataTableHead>
                <DataTableRow>
                  <DataTableHeaderCell>Domain</DataTableHeaderCell>
                  <DataTableHeaderCell>Status</DataTableHeaderCell>
                  <DataTableHeaderCell>Step</DataTableHeaderCell>
                  <DataTableHeaderCell>Server</DataTableHeaderCell>
                  <DataTableHeaderCell>A-record</DataTableHeaderCell>
                  <DataTableHeaderCell align="right">Created</DataTableHeaderCell>
                </DataTableRow>
              </DataTableHead>
              <tbody>
                {DOMAINS.slice(0, 8).map((d) => (
                  <DataTableRow key={d.id}>
                    <DataTableCell>
                      <div className="flex items-center gap-2">
                        {d.status === "live" ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-status-completed" aria-hidden />
                        ) : (
                          <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                        )}
                        <span className="font-medium">{d.name}</span>
                      </div>
                    </DataTableCell>
                    <DataTableCell>
                      <StatusBadge status={d.status} />
                    </DataTableCell>
                    <DataTableCell>
                      <span className="font-mono tabular-nums text-muted-foreground">{d.step}/10</span>
                    </DataTableCell>
                    <DataTableCell>
                      <MonoCode>{d.server}</MonoCode>
                    </DataTableCell>
                    <DataTableCell>
                      <MonoCode>{d.ip}</MonoCode>
                    </DataTableCell>
                    <DataTableCell align="right">
                      <span className="font-mono text-micro text-muted-foreground">{d.createdAt}</span>
                    </DataTableCell>
                  </DataTableRow>
                ))}
              </tbody>
            </DataTable>
          </DataTableShell>
        </section>
      </div>
    </AppShell>
  )
}
