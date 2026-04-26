"use client"

import * as React from "react"
import {
  Plus,
  RefreshCw,
  ArrowLeftRight,
  XCircle,
  Pencil,
  Trash2,
  ChevronDown,
  Search,
  Server as ServerIcon,
  Download,
} from "lucide-react"
import { AppShell } from "@/components/ssr/app-shell"
import { StatusBadge } from "@/components/ssr/status-badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { SERVERS } from "@/lib/ssr/mock-data"
import { cn } from "@/lib/utils"

export default function ServersPage() {
  const [query, setQuery] = React.useState("")

  const filtered = SERVERS.filter((s) =>
    !query
      ? true
      : s.name.includes(query) || s.region.toLowerCase().includes(query.toLowerCase()) || s.ip.includes(query),
  )

  const totalDomains = SERVERS.reduce((acc, s) => acc + s.domains, 0)
  const totalCapacity = SERVERS.filter((s) => s.status === "active").reduce((acc, s) => acc + s.capacity, 0)

  return (
    <AppShell
      title="Servers"
      description={`${SERVERS.length} droplets · ${totalDomains}/${totalCapacity} domains hosted`}
      breadcrumbs={[{ label: "Servers" }]}
      accent="servers"
      actions={
        <>
          <Button variant="outline" size="sm" className="gap-1.5 hidden sm:inline-flex btn-soft-info">
            <RefreshCw className="h-3.5 w-3.5" /> Sync DO
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5 hidden sm:inline-flex">
            <Download className="h-3.5 w-3.5" /> Import
          </Button>
          <Button size="sm" className="gap-1.5 btn-success">
            <Plus className="h-3.5 w-3.5" /> New droplet
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {/* Region capacity summary */}
        <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {Array.from(new Set(SERVERS.map((s) => s.region))).map((region) => {
            const inRegion = SERVERS.filter((s) => s.region === region && s.status === "active")
            const used = inRegion.reduce((acc, s) => acc + s.domains, 0)
            const cap = inRegion.reduce((acc, s) => acc + s.capacity, 0) || 1
            const pct = Math.round((used / cap) * 100)
            return (
              <div key={region} className="rounded-md border border-border bg-card p-3">
                <div className="flex items-center justify-between text-micro">
                  <span className="font-mono uppercase tracking-wider text-muted-foreground">{region}</span>
                  <span className="tabular-nums text-foreground/80">
                    {used}/{cap}
                  </span>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      pct >= 95 ? "bg-status-terminal" : pct >= 75 ? "bg-status-waiting" : "bg-primary",
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="mt-1 text-micro text-muted-foreground">{inRegion.length} active</div>
              </div>
            )
          })}
        </section>

        <DataTableShell>
          <DataTableToolbar>
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, region, or IP…"
                className="h-8 pl-8 text-small"
              />
            </div>
            <ButtonGroup>
              <Button variant="outline" size="sm">
                All
              </Button>
              <Button variant="ghost" size="sm">
                Active
              </Button>
              <Button variant="ghost" size="sm">
                Dead
              </Button>
              <Button variant="ghost" size="sm">
                Migrating
              </Button>
            </ButtonGroup>
            <div className="ml-auto text-micro text-muted-foreground">
              {filtered.length} of {SERVERS.length}
            </div>
          </DataTableToolbar>

          <DataTable>
            <DataTableHead>
              <DataTableRow>
                <DataTableHeaderCell>Name</DataTableHeaderCell>
                <DataTableHeaderCell>Region</DataTableHeaderCell>
                <DataTableHeaderCell>Status</DataTableHeaderCell>
                <DataTableHeaderCell>Size</DataTableHeaderCell>
                <DataTableHeaderCell>IP</DataTableHeaderCell>
                <DataTableHeaderCell>Domains</DataTableHeaderCell>
                <DataTableHeaderCell>Capacity</DataTableHeaderCell>
                <DataTableHeaderCell align="right">Created</DataTableHeaderCell>
                <DataTableHeaderCell align="right">Actions</DataTableHeaderCell>
              </DataTableRow>
            </DataTableHead>
            <tbody>
              {filtered.map((s) => {
                const pct = Math.round((s.domains / s.capacity) * 100)
                return (
                  <DataTableRow key={s.id}>
                    <DataTableCell>
                      <div className="flex items-center gap-2">
                        <ServerIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                        <span className="font-medium font-mono">{s.name}</span>
                      </div>
                    </DataTableCell>
                    <DataTableCell>
                      <span className="font-mono uppercase text-muted-foreground">{s.region}</span>
                    </DataTableCell>
                    <DataTableCell>
                      <StatusBadge status={s.status} />
                    </DataTableCell>
                    <DataTableCell>
                      <MonoCode>{s.size}</MonoCode>
                    </DataTableCell>
                    <DataTableCell>
                      <MonoCode>{s.ip}</MonoCode>
                    </DataTableCell>
                    <DataTableCell>
                      <span className="font-mono tabular-nums">{s.domains}</span>
                    </DataTableCell>
                    <DataTableCell>
                      <div className="flex items-center gap-2 min-w-[120px]">
                        <div className="relative h-1 w-16 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              pct >= 95 ? "bg-status-terminal" : pct >= 75 ? "bg-status-waiting" : "bg-primary",
                            )}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="font-mono text-micro tabular-nums text-muted-foreground">{pct}%</span>
                      </div>
                    </DataTableCell>
                    <DataTableCell align="right">
                      <span className="font-mono text-micro text-muted-foreground">{s.createdAt}</span>
                    </DataTableCell>
                    <DataTableCell align="right">
                      <ButtonGroup className="justify-end">
                        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Migrate" title="Migrate">
                          <ArrowLeftRight className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Mark dead" title="Mark dead">
                          <XCircle className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Edit" title="Edit">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <ButtonGroupSeparator />
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="More">
                              <ChevronDown className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem>SSH details</DropdownMenuItem>
                            <DropdownMenuItem>View domains</DropdownMenuItem>
                            <DropdownMenuItem>Resync agent</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive">
                              <Trash2 className="mr-2 h-3.5 w-3.5" /> Destroy
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </ButtonGroup>
                    </DataTableCell>
                  </DataTableRow>
                )
              })}
            </tbody>
          </DataTable>
        </DataTableShell>
      </div>
    </AppShell>
  )
}
