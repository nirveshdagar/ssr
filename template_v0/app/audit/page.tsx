"use client"

import * as React from "react"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { Search, ChevronDown, User, Cog, X, ShieldOff, ChevronsLeft, ChevronsRight, ChevronLeft, ChevronRight } from "lucide-react"
import { AppShell } from "@/components/ssr/app-shell"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
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
  MonoCode,
} from "@/components/ssr/data-table"
import { useAudit } from "@/hooks/use-audit"
import { cn } from "@/lib/utils"

/**
 * Map an action name to one of three tones — mirrors Flask audit_log.html line 41:
 *   login_fail        → error    (red)
 *   destroy / delete  → warning  (amber)
 *   everything else   → running  (blue)
 */
function actionTone(action: string): "error" | "warning" | "info" {
  if (action === "login_fail") return "error"
  if (/destroy|delete/.test(action)) return "warning"
  return "info"
}

export default function AuditPage() {
  // Wrap in Suspense — child reads useSearchParams which Next requires to
  // be inside a Suspense boundary for the static-prerender bailout path.
  return (
    <React.Suspense fallback={null}>
      <AuditPageInner />
    </React.Suspense>
  )
}

function AuditPageInner() {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [query, setQuery] = React.useState(sp.get("q") ?? "")
  const [action, setAction] = React.useState<string | null>(sp.get("action"))
  const [page, setPage] = React.useState(Number.parseInt(sp.get("page") ?? "1", 10) || 1)
  React.useEffect(() => { setPage(1) }, [query, action])

  // URL-shareable filter state. Pagination too — paste the URL with
  // ?action=server_destroy&page=3 and you land on the same view.
  React.useEffect(() => {
    const params = new URLSearchParams()
    if (action) params.set("action", action)
    if (query.trim()) params.set("q", query)
    if (page > 1) params.set("page", String(page))
    const qs = params.toString()
    const target = qs ? `${pathname}?${qs}` : pathname
    const id = window.setTimeout(() => {
      router.replace(target, { scroll: false })
    }, 250)
    return () => window.clearTimeout(id)
  }, [query, action, page, pathname, router])
  const {
    rows: AUDIT_ENTRIES, total, actions, page: serverPage, lastPage,
  } = useAudit({ q: query || null, action, page })

  const filterActive = Boolean(query || action)

  return (
    <AppShell
      title="Audit Log"
      description="Operator and system actions across the platform"
      breadcrumbs={[{ label: "Audit Log" }]}
      accent="audit"
      actions={
        <span className="text-small text-muted-foreground inline-flex items-center gap-1.5">
          Total: <strong className="text-foreground tabular-nums font-mono">{total}</strong> entries
          {filterActive && <span className="text-muted-foreground/70">(filtered)</span>}
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        <DataTableShell>
          <DataTableToolbar>
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search target, detail, or actor IP…"
                className="h-8 pl-8 text-small"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline" size="sm" className="gap-1.5"
                  title="Filter by exact action — counts beside each row show how many entries that action has"
                >
                  {action ?? `All actions (${actions.length})`}
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64 max-h-72 overflow-y-auto">
                <DropdownMenuLabel>Filter by action</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => setAction(null)}>All actions</DropdownMenuItem>
                <DropdownMenuSeparator />
                {actions.map((a) => (
                  <DropdownMenuItem key={a.action} onClick={() => setAction(a.action)}>
                    <code className="font-mono text-micro">{a.action}</code>
                    <span className="ml-auto text-micro text-muted-foreground tabular-nums">{a.n}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {filterActive && (
              <Button
                variant="outline" size="sm" className="gap-1.5"
                onClick={() => { setQuery(""); setAction(null) }}
                title="Clear search box and action filter"
              >
                <X className="h-3.5 w-3.5" /> Clear
              </Button>
            )}
            <div className="ml-auto text-micro text-muted-foreground">
              page {serverPage} of {lastPage}
            </div>
          </DataTableToolbar>

          <DataTable>
            <DataTableHead>
              <DataTableRow>
                <DataTableHeaderCell className="w-[160px]">Timestamp</DataTableHeaderCell>
                <DataTableHeaderCell className="w-[140px]">Actor IP</DataTableHeaderCell>
                <DataTableHeaderCell className="w-[200px]">Action</DataTableHeaderCell>
                <DataTableHeaderCell className="w-[200px]">Target</DataTableHeaderCell>
                <DataTableHeaderCell>Detail</DataTableHeaderCell>
              </DataTableRow>
            </DataTableHead>
            <tbody>
              {AUDIT_ENTRIES.map((a) => {
                const isSystem = !a.actor || a.actor === "system" || a.actor === ""
                const tone = actionTone(a.action)
                return (
                  <DataTableRow key={a.id}>
                    <DataTableCell>
                      <span className="font-mono text-micro tabular-nums text-muted-foreground">{a.ts}</span>
                    </DataTableCell>
                    <DataTableCell>
                      <span
                        className="inline-flex items-center gap-1.5"
                        title={isSystem ? "System-initiated (no remote IP)" : `Operator request from ${a.actor}`}
                      >
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted">
                          {isSystem ? (
                            <Cog className="h-3 w-3 text-muted-foreground" aria-hidden />
                          ) : (
                            <User className="h-3 w-3 text-muted-foreground" aria-hidden />
                          )}
                        </span>
                        <span className="font-mono text-micro">{a.actor || "system"}</span>
                      </span>
                    </DataTableCell>
                    <DataTableCell>
                      <code
                        className={cn(
                          "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-micro font-medium",
                          tone === "error" && "bg-status-terminal/15 text-status-terminal",
                          tone === "warning" && "bg-status-waiting/15 text-status-waiting",
                          tone === "info" && "bg-status-running/12 text-status-running",
                        )}
                        title={
                          tone === "error" ? "Failure / security event" :
                          tone === "warning" ? "Destructive action — server/CF/domain delete" :
                          "Routine operator action"
                        }
                      >
                        {a.action}
                      </code>
                    </DataTableCell>
                    <DataTableCell>
                      {a.target ? <MonoCode>{a.target}</MonoCode> : <span className="text-muted-foreground">—</span>}
                    </DataTableCell>
                    <DataTableCell>
                      <span className="text-foreground/85 break-all">{a.detail}</span>
                    </DataTableCell>
                  </DataTableRow>
                )
              })}
              {AUDIT_ENTRIES.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-12">
                    <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
                      <ShieldOff className="h-8 w-8" aria-hidden />
                      <p className="text-small">
                        {filterActive
                          ? "No audit entries match the current filter."
                          : "No audit entries yet."}
                      </p>
                      {filterActive && (
                        <Button
                          variant="outline" size="sm" className="gap-1.5"
                          onClick={() => { setQuery(""); setAction(null) }}
                          title="Clear filters and show all entries"
                        >
                          <X className="h-3.5 w-3.5" /> Clear filters
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </DataTable>

          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-small text-muted-foreground">
            <span>
              Page <span className="font-mono tabular-nums text-foreground">{serverPage}</span> of{" "}
              <span className="font-mono tabular-nums text-foreground">{lastPage}</span>
              {" "}· 50 per page
            </span>
            <ButtonGroup>
              <Button
                variant="outline" size="sm" className="gap-1"
                disabled={serverPage <= 1}
                onClick={() => setPage(1)}
                title="Jump to first page"
              >
                <ChevronsLeft className="h-3.5 w-3.5" /> First
              </Button>
              <Button
                variant="outline" size="sm" className="gap-1"
                disabled={serverPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                title="Previous page"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </Button>
              <Button
                variant="outline" size="sm" className="gap-1"
                disabled={serverPage >= lastPage}
                onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
                title="Next page"
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline" size="sm" className="gap-1"
                disabled={serverPage >= lastPage}
                onClick={() => setPage(lastPage)}
                title="Jump to last page"
              >
                Last <ChevronsRight className="h-3.5 w-3.5" />
              </Button>
            </ButtonGroup>
          </div>
        </DataTableShell>
      </div>
    </AppShell>
  )
}
