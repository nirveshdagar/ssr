"use client"

import * as React from "react"
import { Search, Download, ChevronDown, User, Cog } from "lucide-react"
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
import { AUDIT_ENTRIES } from "@/lib/ssr/mock-data"

const ACTION_GROUPS = [
  "domain.bulk_update",
  "domain.cancel",
  "domain.hard_delete",
  "pipeline.run",
  "server.create",
  "server.mark_dead",
  "cf_key.add",
  "settings.update",
  "auth.login",
]

export default function AuditPage() {
  const [query, setQuery] = React.useState("")
  const filtered = AUDIT_ENTRIES.filter(
    (a) =>
      !query ||
      a.target.toLowerCase().includes(query.toLowerCase()) ||
      a.action.toLowerCase().includes(query.toLowerCase()) ||
      a.detail.toLowerCase().includes(query.toLowerCase()),
  )

  return (
    <AppShell
      title="Audit Log"
      description="Operator and system actions across the platform"
      breadcrumbs={[{ label: "Audit Log" }]}
      accent="audit"
      actions={
        <Button variant="outline" size="sm" className="gap-1.5">
          <Download className="h-3.5 w-3.5" /> Export
        </Button>
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
                placeholder="Search target, action, or detail…"
                className="h-8 pl-8 text-small"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  Action
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>Filter by action</DropdownMenuLabel>
                <DropdownMenuItem>All actions</DropdownMenuItem>
                <DropdownMenuSeparator />
                {ACTION_GROUPS.map((a) => (
                  <DropdownMenuItem key={a}>
                    <code className="font-mono text-micro">{a}</code>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  Actor
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40">
                <DropdownMenuItem>All actors</DropdownMenuItem>
                <DropdownMenuItem>operator</DropdownMenuItem>
                <DropdownMenuItem>system</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  Last 7d
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40">
                <DropdownMenuItem>Last 24h</DropdownMenuItem>
                <DropdownMenuItem>Last 7 days</DropdownMenuItem>
                <DropdownMenuItem>Last 30 days</DropdownMenuItem>
                <DropdownMenuItem>All time</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="ml-auto text-micro text-muted-foreground">
              {filtered.length} entries
            </div>
          </DataTableToolbar>

          <DataTable>
            <DataTableHead>
              <DataTableRow>
                <DataTableHeaderCell className="w-[160px]">Timestamp</DataTableHeaderCell>
                <DataTableHeaderCell className="w-[120px]">Actor</DataTableHeaderCell>
                <DataTableHeaderCell className="w-[200px]">Action</DataTableHeaderCell>
                <DataTableHeaderCell className="w-[200px]">Target</DataTableHeaderCell>
                <DataTableHeaderCell>Detail</DataTableHeaderCell>
              </DataTableRow>
            </DataTableHead>
            <tbody>
              {filtered.map((a) => {
                const isSystem = a.actor === "system"
                return (
                  <DataTableRow key={a.id}>
                    <DataTableCell>
                      <span className="font-mono text-micro tabular-nums text-muted-foreground">{a.ts}</span>
                    </DataTableCell>
                    <DataTableCell>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted">
                          {isSystem ? (
                            <Cog className="h-3 w-3 text-muted-foreground" aria-hidden />
                          ) : (
                            <User className="h-3 w-3 text-muted-foreground" aria-hidden />
                          )}
                        </span>
                        <span className="text-[12px] font-medium">{a.actor}</span>
                      </span>
                    </DataTableCell>
                    <DataTableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-micro text-foreground/80">
                        {a.action}
                      </code>
                    </DataTableCell>
                    <DataTableCell>
                      <MonoCode>{a.target}</MonoCode>
                    </DataTableCell>
                    <DataTableCell>
                      <span className="text-foreground/85">{a.detail}</span>
                    </DataTableCell>
                  </DataTableRow>
                )
              })}
            </tbody>
          </DataTable>

          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-small text-muted-foreground">
            <span>
              Page <span className="font-mono tabular-nums text-foreground">1</span> of{" "}
              <span className="font-mono tabular-nums text-foreground">18</span>
            </span>
            <ButtonGroup>
              <Button variant="outline" size="sm" disabled>Previous</Button>
              <Button variant="outline" size="sm">Next</Button>
            </ButtonGroup>
          </div>
        </DataTableShell>
      </div>
    </AppShell>
  )
}
