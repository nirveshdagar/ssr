"use client"

import * as React from "react"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { Search, Filter, ChevronDown, X } from "lucide-react"
import { AppShell } from "@/components/ssr/app-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  DataTableShell,
  DataTableToolbar,
  DataTable,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  DataTableCell,
} from "@/components/ssr/data-table"
import { useLogs } from "@/hooks/use-logs"
import { useDomains } from "@/hooks/use-domains"
import { useAudit } from "@/hooks/use-audit"
import { cn } from "@/lib/utils"

const LEVELS = [
  { key: "all" as const, label: "All" },
  { key: "info" as const, label: "Info" },
  { key: "warn" as const, label: "Warn" },
  { key: "error" as const, label: "Error" },
  { key: "debug" as const, label: "Debug" },
]

export default function LogsPage() {
  return (
    <React.Suspense fallback={null}>
      <LogsPageInner />
    </React.Suspense>
  )
}

function LogsPageInner() {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [level, setLevel] = React.useState<string>(sp.get("level") ?? "all")
  const [domainFilter, setDomainFilter] = React.useState<string | null>(sp.get("domain"))
  const [query, setQuery] = React.useState(sp.get("q") ?? "")
  const [stepFilter, setStepFilter] = React.useState<string | null>(sp.get("step"))
  // Rows fetched (most-recent N). Was hard-pinned at 500, silently hiding
  // older history; the API already supports up to 5000.
  const [rowLimit, setRowLimit] = React.useState<number>(500)
  const ROW_OPTIONS = [500, 1000, 2000, 5000]

  // Reflect filters back into the URL so the view is shareable + bookmarkable.
  React.useEffect(() => {
    const params = new URLSearchParams()
    if (level !== "all") params.set("level", level)
    if (domainFilter) params.set("domain", domainFilter)
    if (stepFilter) params.set("step", stepFilter)
    if (query.trim()) params.set("q", query)
    const qs = params.toString()
    const target = qs ? `${pathname}?${qs}` : pathname
    const id = window.setTimeout(() => {
      router.replace(target, { scroll: false })
    }, 250)
    return () => window.clearTimeout(id)
  }, [level, domainFilter, stepFilter, query, pathname, router])

  const { events: LOG_EVENTS } = useLogs({ domain: domainFilter, limit: rowLimit })
  const { rows: DOMAINS } = useDomains()

  const counts: Record<string, number> = { all: LOG_EVENTS.length, info: 0, warn: 0, error: 0, debug: 0 }
  for (const e of LOG_EVENTS) counts[e.level] = (counts[e.level] ?? 0) + 1

  const filtered = LOG_EVENTS.filter((l) => {
    if (level !== "all" && l.level !== level) return false
    if (stepFilter && l.step !== stepFilter) return false
    if (query) {
      const q = query.toLowerCase()
      if (!l.message.toLowerCase().includes(q) &&
          !l.domain.toLowerCase().includes(q) &&
          !l.step.toLowerCase().includes(q)) return false
    }
    return true
  })

  const distinctSteps = Array.from(new Set(LOG_EVENTS.map((l) => l.step))).sort()

  return (
    <AppShell
      title="Logs"
      description="Pipeline event log · paginated, filterable, full-text search"
      breadcrumbs={[{ label: "Logs" }]}
      accent="logs"
    >
      <div className="flex flex-col gap-3">
        {domainFilter && (
          <div className="flex items-center gap-2">
            <span className="rounded bg-muted px-2 py-1 text-small">
              Domain: <code className="font-mono">{domainFilter}</code>
            </span>
            <button
              className="text-micro text-muted-foreground hover:text-foreground"
              onClick={() => setDomainFilter(null)}
              aria-label="Clear domain filter"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1">
          {LEVELS.map((l) => {
            const active = level === l.key
            const c = counts[l.key] ?? 0
            return (
              <button
                key={l.key}
                onClick={() => setLevel(l.key)}
                title={
                  l.key === "all"
                    ? "Show every log level"
                    : `Show only ${l.label.toLowerCase()} entries (Flask 'pipeline_log' status mapped to this level)`
                }
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-small font-medium transition-colors",
                  active
                    ? "border-foreground/20 bg-foreground text-background"
                    : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    l.key === "info" && "bg-status-running",
                    l.key === "warn" && "bg-status-waiting",
                    l.key === "error" && "bg-status-terminal",
                    l.key === "debug" && "bg-status-pending",
                    l.key === "all" && (active ? "bg-background" : "bg-muted-foreground"),
                  )}
                />
                {l.label}
                <span
                  className={cn(
                    "rounded px-1 py-px text-micro tabular-nums",
                    active ? "bg-background/15 text-background" : "bg-muted text-muted-foreground",
                  )}
                >
                  {c}
                </span>
              </button>
            )
          })}
        </div>

        <DataTableShell>
          <DataTableToolbar>
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search messages, domains, step…"
                className="h-8 pl-8 text-small"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline" size="sm" className="gap-1.5"
                  title="Filter to a single domain — same dropdown as the per-row Watcher link"
                >
                  <Filter className="h-3.5 w-3.5" />
                  {domainFilter ?? "All domains"}
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64 max-h-72 overflow-y-auto">
                <DropdownMenuLabel>Filter by domain</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => setDomainFilter(null)}>All domains</DropdownMenuItem>
                <DropdownMenuSeparator />
                {DOMAINS.map((d) => (
                  <DropdownMenuItem key={d.id} onClick={() => setDomainFilter(d.name)}>
                    <code className="font-mono text-micro">{d.name}</code>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline" size="sm" className="gap-1.5"
                  title="Filter to a single pipeline step (e.g. step_8_install_ssl)"
                >
                  {stepFilter ?? "All steps"}
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64 max-h-72 overflow-y-auto">
                <DropdownMenuLabel>Filter by step</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => setStepFilter(null)}>All steps</DropdownMenuItem>
                <DropdownMenuSeparator />
                {distinctSteps.map((s) => (
                  <DropdownMenuItem key={s} onClick={() => setStepFilter(s)}>
                    <code className="font-mono text-micro">{s}</code>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {(query || stepFilter || level !== "all" || domainFilter) && (
              <Button
                variant="outline" size="sm" className="gap-1.5"
                onClick={() => { setQuery(""); setLevel("all"); setStepFilter(null); setDomainFilter(null) }}
                title="Clear search + level + domain + step filters"
              >
                <X className="h-3.5 w-3.5" /> Clear
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline" size="sm" className="gap-1.5"
                  title="How many of the most-recent log rows to load (API supports up to 5000)"
                >
                  {rowLimit} rows
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40">
                <DropdownMenuLabel>Rows to load</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {ROW_OPTIONS.map((n) => (
                  <DropdownMenuItem key={n} onClick={() => setRowLimit(n)}>
                    {n.toLocaleString()} {n === rowLimit ? "✓" : ""}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="ml-auto text-micro text-muted-foreground">
              {filtered.length} of {LOG_EVENTS.length} (last {rowLimit.toLocaleString()})
            </div>
          </DataTableToolbar>

          <DataTable>
            <DataTableHead>
              <DataTableRow>
                <DataTableHeaderCell className="w-[160px]">Timestamp</DataTableHeaderCell>
                <DataTableHeaderCell className="w-[80px]">Level</DataTableHeaderCell>
                <DataTableHeaderCell className="w-[180px]">Domain</DataTableHeaderCell>
                <DataTableHeaderCell className="w-[140px]">Step</DataTableHeaderCell>
                <DataTableHeaderCell>Message</DataTableHeaderCell>
              </DataTableRow>
            </DataTableHead>
            <tbody>
              {filtered.map((l) => (
                <DataTableRow key={l.id}>
                  <DataTableCell>
                    <span className="font-mono text-micro tabular-nums text-muted-foreground">{l.ts}</span>
                  </DataTableCell>
                  <DataTableCell>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-micro font-mono font-semibold uppercase",
                        l.level === "info" && "bg-status-running/10 text-status-running",
                        l.level === "warn" && "bg-status-waiting/10 text-status-waiting",
                        l.level === "error" && "bg-status-terminal/10 text-status-terminal",
                        l.level === "debug" && "bg-muted text-muted-foreground",
                      )}
                    >
                      {l.level}
                    </span>
                  </DataTableCell>
                  <DataTableCell>
                    <span className="font-medium break-all">{l.domain}</span>
                  </DataTableCell>
                  <DataTableCell>
                    <code className="font-mono text-micro text-muted-foreground">{l.step}</code>
                  </DataTableCell>
                  <DataTableCell>
                    <span className="text-foreground/85 break-words">{l.message}</span>
                  </DataTableCell>
                </DataTableRow>
              ))}
              {filtered.length === 0 && (
                <DataTableRow>
                  <DataTableCell>
                    <span className="text-micro text-muted-foreground">No matching log events.</span>
                  </DataTableCell>
                </DataTableRow>
              )}
            </tbody>
          </DataTable>
        </DataTableShell>

        {/* Embedded recent audit-log section — Flask renders this same panel
            below the pipeline log on the /logs page. Operators get a single
            view of "what's happening" + "who did what" without flipping pages. */}
        <RecentAuditPanel />
      </div>
    </AppShell>
  )
}

function RecentAuditPanel() {
  const { rows: auditRows } = useAudit({ page: 1 })
  const recent = auditRows.slice(0, 50)
  return (
    <DataTableShell>
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold tracking-tight">Recent audit log</h2>
          <span
            className="rounded bg-muted px-1.5 py-0.5 text-micro font-medium tabular-nums text-muted-foreground"
            title="Last 50 operator/system actions — open the full audit page for filtering + pagination"
          >
            Last {recent.length}
          </span>
        </div>
        <a
          href="/audit"
          className="text-micro text-muted-foreground hover:text-foreground"
          title="Open the full audit page — filter by action, search, paginate"
        >
          Open full audit log →
        </a>
      </header>
      <DataTable>
        <DataTableHead>
          <DataTableRow>
            <DataTableHeaderCell className="w-[160px]">Timestamp</DataTableHeaderCell>
            <DataTableHeaderCell className="w-[140px]">Actor IP</DataTableHeaderCell>
            <DataTableHeaderCell className="w-[180px]">Action</DataTableHeaderCell>
            <DataTableHeaderCell className="w-[180px]">Target</DataTableHeaderCell>
            <DataTableHeaderCell>Detail</DataTableHeaderCell>
          </DataTableRow>
        </DataTableHead>
        <tbody>
          {recent.map((a) => (
            <DataTableRow key={a.id}>
              <DataTableCell>
                <span className="font-mono text-micro tabular-nums text-muted-foreground">{a.ts}</span>
              </DataTableCell>
              <DataTableCell>
                <span className="font-mono text-micro">{a.actor || "system"}</span>
              </DataTableCell>
              <DataTableCell>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-micro text-foreground/80">
                  {a.action}
                </code>
              </DataTableCell>
              <DataTableCell>
                <span className="font-mono text-micro break-all">{a.target || "—"}</span>
              </DataTableCell>
              <DataTableCell>
                <span className="text-foreground/85 break-words">{a.detail}</span>
              </DataTableCell>
            </DataTableRow>
          ))}
          {recent.length === 0 && (
            <DataTableRow>
              <DataTableCell><span className="text-micro text-muted-foreground">No audit entries yet.</span></DataTableCell>
            </DataTableRow>
          )}
        </tbody>
      </DataTable>
    </DataTableShell>
  )
}
