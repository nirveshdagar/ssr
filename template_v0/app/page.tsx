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
import { KpiTile } from "@/components/ssr/kpi-tile"
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
import { ACTIVITY_FEED, DOMAINS } from "@/lib/ssr/mock-data"
import { cn } from "@/lib/utils"

export default function DashboardPage() {
  const activeRuns = DOMAINS.filter((d) => d.status === "running" || d.status === "waiting").slice(0, 3)

  return (
    <AppShell
      title="Dashboard"
      description="Pipeline health and recent operator activity"
      accent="dashboard"
      actions={
        <>
          <Button variant="outline" size="sm" className="gap-1.5 hidden sm:inline-flex btn-soft-info">
            <RefreshCw className="h-3.5 w-3.5" /> Sync
          </Button>
          <Button size="sm" className="gap-1.5 btn-success">
            <Plus className="h-3.5 w-3.5" /> New pipeline
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {/* KPI grid */}
        <section aria-label="Key metrics" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiTile
            label="Live domains"
            value="248"
            change={{ value: "+12 this week", direction: "up", positive: true }}
            icon={Globe}
            accent="success"
          />
          <KpiTile
            label="Active pipelines"
            value="3"
            change={{ value: "12 queued", direction: "flat" }}
            icon={Activity}
            hint="avg 4m 12s"
            accent="info"
          />
          <KpiTile
            label="Healthy servers"
            value="13 / 14"
            change={{ value: "1 dead", direction: "down", positive: false }}
            icon={ServerIcon}
            accent="warning"
          />
          <KpiTile
            label="Errors (24h)"
            value="7"
            change={{ value: "−3 vs yesterday", direction: "down", positive: true }}
            icon={AlertTriangle}
            accent="danger"
          />
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
              {[
                { name: "do-nyc3-01", region: "NYC3", used: 18, max: 25 },
                { name: "do-nyc3-02", region: "NYC3", used: 22, max: 25 },
                { name: "do-sfo3-01", region: "SFO3", used: 25, max: 25 },
                { name: "do-fra1-01", region: "FRA1", used: 14, max: 25 },
                { name: "do-sgp1-01", region: "SGP1", used: 9,  max: 25 },
              ].map((s) => {
                const pct = Math.round((s.used / s.max) * 100)
                const danger = pct >= 95
                const warn = pct >= 75
                return (
                  <div key={s.name} className="flex items-center gap-3">
                    <div className="w-28 min-w-0">
                      <div className="truncate text-[12px] font-medium">{s.name}</div>
                      <div className="text-micro text-muted-foreground">{s.region}</div>
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
                      {s.used}/{s.max}
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
              {[
                { id: "cf-pool-01", used: 38, status: "healthy" as const },
                { id: "cf-pool-02", used: 71, status: "warning" as const },
                { id: "cf-pool-03", used: 22, status: "healthy" as const },
                { id: "cf-pool-04", used: 44, status: "healthy" as const },
                { id: "cf-pool-05", used: 92, status: "exhausted" as const },
                { id: "cf-pool-06", used: 18, status: "healthy" as const },
              ].map((k) => (
                <div key={k.id} className="flex items-center gap-3">
                  <div className="w-28">
                    <code className="font-mono text-[12px] font-medium">{k.id}</code>
                  </div>
                  <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        k.status === "exhausted" && "bg-status-terminal",
                        k.status === "warning" && "bg-status-waiting",
                        k.status === "healthy" && "bg-primary",
                      )}
                      style={{ width: `${k.used}%` }}
                    />
                  </div>
                  <div className="w-12 text-right font-mono text-micro tabular-nums text-muted-foreground">{k.used}%</div>
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
                  <DataTableHeaderCell>IP</DataTableHeaderCell>
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
