"use client"

import * as React from "react"
import {
  Search,
  Plus,
  Filter,
  Play,
  Eye,
  History,
  Ban,
  Trash2,
  Archive,
  ChevronDown,
  Download,
  Upload,
  X,
} from "lucide-react"
import { AppShell } from "@/components/ssr/app-shell"
import { StatusBadge } from "@/components/ssr/status-badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
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
import { DOMAINS, type PipelineStatus } from "@/lib/ssr/mock-data"
import { cn } from "@/lib/utils"

const STATUS_FILTERS: { key: PipelineStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "live", label: "Live" },
  { key: "running", label: "Running" },
  { key: "waiting", label: "Waiting" },
  { key: "retryable_error", label: "Retrying" },
  { key: "terminal_error", label: "Failed" },
  { key: "canceled", label: "Canceled" },
]

export default function DomainsPage() {
  const [filter, setFilter] = React.useState<PipelineStatus | "all">("all")
  const [query, setQuery] = React.useState("")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())

  const filtered = DOMAINS.filter((d) => {
    if (filter !== "all" && d.status !== filter) return false
    if (query && !d.name.toLowerCase().includes(query.toLowerCase())) return false
    return true
  })

  const allSelected = filtered.length > 0 && filtered.every((d) => selected.has(d.id))
  const someSelected = selected.size > 0 && !allSelected

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filtered.map((d) => d.id)))
    }
  }
  function toggleOne(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  return (
    <AppShell
      title="Domains"
      description={`${DOMAINS.length} total · pipelines, status, server, and IP`}
      breadcrumbs={[{ label: "Domains" }]}
      accent="domains"
      actions={
        <>
          <Button variant="outline" size="sm" className="gap-1.5 hidden sm:inline-flex">
            <Download className="h-3.5 w-3.5" /> Export
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5 hidden sm:inline-flex btn-soft-info">
            <Upload className="h-3.5 w-3.5" /> Import CSV
          </Button>
          <Button size="sm" className="gap-1.5 btn-info">
            <Plus className="h-3.5 w-3.5" /> Add domain
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* Status filter chips */}
        <div className="flex flex-wrap items-center gap-1">
          {STATUS_FILTERS.map((f) => {
            const count =
              f.key === "all" ? DOMAINS.length : DOMAINS.filter((d) => d.status === f.key).length
            const active = filter === f.key
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-small font-medium transition-colors",
                  active
                    ? "border-foreground/20 bg-foreground text-background"
                    : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {f.label}
                <span
                  className={cn(
                    "rounded px-1 py-px text-micro tabular-nums",
                    active ? "bg-background/15 text-background" : "bg-muted text-muted-foreground",
                  )}
                >
                  {count}
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
                placeholder="Search domains…"
                className="h-8 pl-8 text-small"
              />
            </div>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Filter className="h-3.5 w-3.5" /> Filter
              <span className="rounded bg-muted px-1 py-px text-micro text-muted-foreground">2</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  Sort
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                <DropdownMenuItem>Newest first</DropdownMenuItem>
                <DropdownMenuItem>Oldest first</DropdownMenuItem>
                <DropdownMenuItem>Name (A–Z)</DropdownMenuItem>
                <DropdownMenuItem>Status</DropdownMenuItem>
                <DropdownMenuItem>Step number</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="ml-auto text-micro text-muted-foreground">
              {filtered.length} of {DOMAINS.length}
            </div>
          </DataTableToolbar>

          <DataTable>
            <DataTableHead>
              <DataTableRow>
                <DataTableHeaderCell className="w-9">
                  <Checkbox
                    aria-label="Select all"
                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={toggleAll}
                  />
                </DataTableHeaderCell>
                <DataTableHeaderCell>Domain</DataTableHeaderCell>
                <DataTableHeaderCell>Status</DataTableHeaderCell>
                <DataTableHeaderCell>Step</DataTableHeaderCell>
                <DataTableHeaderCell>Server</DataTableHeaderCell>
                <DataTableHeaderCell>CF key</DataTableHeaderCell>
                <DataTableHeaderCell>IP</DataTableHeaderCell>
                <DataTableHeaderCell align="right">Created</DataTableHeaderCell>
                <DataTableHeaderCell align="right">Actions</DataTableHeaderCell>
              </DataTableRow>
            </DataTableHead>
            <tbody>
              {filtered.map((d) => (
                <DataTableRow key={d.id} selected={selected.has(d.id)}>
                  <DataTableCell>
                    <Checkbox
                      aria-label={`Select ${d.name}`}
                      checked={selected.has(d.id)}
                      onCheckedChange={() => toggleOne(d.id)}
                    />
                  </DataTableCell>
                  <DataTableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{d.name}</span>
                      {d.registrar === "Imported" && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-micro font-medium text-muted-foreground">
                          imported
                        </span>
                      )}
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
                    <MonoCode>{d.cfKey}</MonoCode>
                  </DataTableCell>
                  <DataTableCell>
                    <MonoCode>{d.ip}</MonoCode>
                  </DataTableCell>
                  <DataTableCell align="right">
                    <span className="font-mono text-micro text-muted-foreground">{d.createdAt}</span>
                  </DataTableCell>
                  <DataTableCell align="right">
                    <ButtonGroup className="justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-[color:var(--success)] hover:bg-[color:color-mix(in_oklch,var(--success)_14%,transparent)] hover:text-[color:var(--success)]"
                        aria-label="Run pipeline"
                        title="Run pipeline"
                      >
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-[color:var(--info)] hover:bg-[color:color-mix(in_oklch,var(--info)_14%,transparent)] hover:text-[color:var(--info)]"
                        aria-label="Watch steps"
                        title="Watch steps"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="History" title="History">
                        <History className="h-3.5 w-3.5" />
                      </Button>
                      <ButtonGroupSeparator />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="More actions">
                            <ChevronDown className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem>
                            <Ban className="mr-2 h-3.5 w-3.5" /> Cancel
                          </DropdownMenuItem>
                          <DropdownMenuItem>
                            <Archive className="mr-2 h-3.5 w-3.5" /> Soft delete
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive">
                            <Trash2 className="mr-2 h-3.5 w-3.5" /> Hard delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </ButtonGroup>
                  </DataTableCell>
                </DataTableRow>
              ))}
            </tbody>
          </DataTable>

          {/* Footer / pagination */}
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-small text-muted-foreground">
            <span>
              Showing <span className="font-mono tabular-nums text-foreground">1–{filtered.length}</span> of{" "}
              <span className="font-mono tabular-nums text-foreground">{DOMAINS.length}</span>
            </span>
            <ButtonGroup>
              <Button variant="outline" size="sm" disabled>
                Previous
              </Button>
              <Button variant="outline" size="sm">
                Next
              </Button>
            </ButtonGroup>
          </div>
        </DataTableShell>

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div
            role="toolbar"
            aria-label="Bulk actions"
            className="sticky bottom-4 mx-auto flex w-full max-w-3xl items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-lg"
          >
            <button
              onClick={() => setSelected(new Set())}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Clear selection"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <span className="text-[13px] font-medium">
              {selected.size} {selected.size === 1 ? "domain" : "domains"} selected
            </span>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            <ButtonGroup>
              <Button size="sm" variant="outline" className="gap-1.5 btn-soft-success">
                <Play className="h-3.5 w-3.5" /> Run pipeline
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 btn-soft-warning">
                <Ban className="h-3.5 w-3.5" /> Cancel
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 btn-soft-destructive">
                <Archive className="h-3.5 w-3.5" /> Soft delete
              </Button>
            </ButtonGroup>
            <ButtonGroup className="ml-auto">
              <Button size="sm" variant="outline" className="gap-1.5 text-status-terminal hover:text-status-terminal">
                <Trash2 className="h-3.5 w-3.5" /> Hard delete
              </Button>
            </ButtonGroup>
          </div>
        )}
      </div>
    </AppShell>
  )
}
