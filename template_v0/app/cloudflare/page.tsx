"use client"

import * as React from "react"
import {
  Plus,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Search,
  Cloud,
  Globe,
  Upload,
  ShieldCheck,
  Zap,
  MoreHorizontal,
  X,
} from "lucide-react"
import { AppShell } from "@/components/ssr/app-shell"
import { StatusBadge } from "@/components/ssr/status-badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { CF_KEYS, DOMAINS } from "@/lib/ssr/mock-data"
import { cn } from "@/lib/utils"

export default function CloudflarePage() {
  const [expanded, setExpanded] = React.useState<string | null>("cf-pool-02")
  const [selected, setSelected] = React.useState<Set<string>>(new Set())

  function toggleRow(id: string) {
    setExpanded((prev) => (prev === id ? null : id))
    setSelected(new Set())
  }
  function toggleDomain(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  return (
    <AppShell
      title="Cloudflare"
      description={`${CF_KEYS.length} pooled API keys · click a row to manage assigned domains`}
      breadcrumbs={[{ label: "Cloudflare" }]}
      accent="cloudflare"
      actions={
        <>
          <Button variant="outline" size="sm" className="gap-1.5 hidden sm:inline-flex btn-soft-warning">
            <RefreshCw className="h-3.5 w-3.5" /> Sync zones
          </Button>
          <Button size="sm" className="gap-1.5 btn-warning">
            <Plus className="h-3.5 w-3.5" /> Add API key
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <DataTableShell>
          <DataTableToolbar>
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search keys or assigned domains…" className="h-8 pl-8 text-small" />
            </div>
            <div className="ml-auto text-micro text-muted-foreground">
              {CF_KEYS.length} keys ·{" "}
              {CF_KEYS.reduce((acc, k) => acc + k.domains, 0)} domains assigned
            </div>
          </DataTableToolbar>

          <DataTable>
            <DataTableHead>
              <DataTableRow>
                <DataTableHeaderCell className="w-9" />
                <DataTableHeaderCell>Key label</DataTableHeaderCell>
                <DataTableHeaderCell>Email</DataTableHeaderCell>
                <DataTableHeaderCell>Domains</DataTableHeaderCell>
                <DataTableHeaderCell>Rate limit</DataTableHeaderCell>
                <DataTableHeaderCell>Status</DataTableHeaderCell>
                <DataTableHeaderCell align="right">Last used</DataTableHeaderCell>
                <DataTableHeaderCell align="right">Actions</DataTableHeaderCell>
              </DataTableRow>
            </DataTableHead>
            <tbody>
              {CF_KEYS.map((k) => {
                const isOpen = expanded === k.id
                const assigned = DOMAINS.slice(0, 6).map((d, i) => ({
                  ...d,
                  cfKey: k.id,
                  ip: d.ip === "—" ? `164.92.18.${100 + i}` : d.ip,
                }))
                return (
                  <React.Fragment key={k.id}>
                    <DataTableRow selected={isOpen}>
                      <DataTableCell>
                        <button
                          onClick={() => toggleRow(k.id)}
                          aria-label={isOpen ? "Collapse row" : "Expand row"}
                          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </button>
                      </DataTableCell>
                      <DataTableCell>
                        <div className="flex items-center gap-2">
                          <Cloud className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                          <code className="font-mono font-medium">{k.label}</code>
                        </div>
                      </DataTableCell>
                      <DataTableCell>
                        <span className="text-muted-foreground">{k.email}</span>
                      </DataTableCell>
                      <DataTableCell>
                        <span className="font-mono tabular-nums">{k.domains}</span>
                      </DataTableCell>
                      <DataTableCell>
                        <div className="flex items-center gap-2 min-w-[120px]">
                          <div className="relative h-1 w-20 overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn(
                                "h-full rounded-full",
                                k.rateLimitUsed >= 90
                                  ? "bg-status-terminal"
                                  : k.rateLimitUsed >= 70
                                    ? "bg-status-waiting"
                                    : "bg-primary",
                              )}
                              style={{ width: `${k.rateLimitUsed}%` }}
                            />
                          </div>
                          <span className="font-mono text-micro tabular-nums text-muted-foreground">
                            {k.rateLimitUsed}%
                          </span>
                        </div>
                      </DataTableCell>
                      <DataTableCell>
                        <StatusBadge status={k.status} />
                      </DataTableCell>
                      <DataTableCell align="right">
                        <span className="font-mono text-micro text-muted-foreground">{k.lastUsed}</span>
                      </DataTableCell>
                      <DataTableCell align="right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Key actions">
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem>Rotate key</DropdownMenuItem>
                            <DropdownMenuItem>Test connectivity</DropdownMenuItem>
                            <DropdownMenuItem>Pause assignments</DropdownMenuItem>
                            <DropdownMenuItem variant="destructive">Remove from pool</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </DataTableCell>
                    </DataTableRow>

                    {isOpen && (
                      <tr>
                        <td colSpan={8} className="bg-muted/30 p-0 border-b border-border">
                          <div className="px-4 py-3">
                            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <h3 className="text-[13px] font-semibold">Domains on {k.label}</h3>
                                <span className="rounded bg-card px-1.5 py-0.5 text-micro font-medium tabular-nums text-muted-foreground border border-border">
                                  {assigned.length} of {k.domains}
                                </span>
                              </div>
                              <ButtonGroup>
                                <Button variant="outline" size="sm" className="gap-1.5">
                                  <Zap className="h-3.5 w-3.5" /> Change A-record IP
                                </Button>
                                <Button variant="outline" size="sm" className="gap-1.5">
                                  <ShieldCheck className="h-3.5 w-3.5" /> SSL mode
                                </Button>
                                <Button variant="outline" size="sm">
                                  Always HTTPS
                                </Button>
                                <Button variant="outline" size="sm" className="gap-1.5">
                                  <Upload className="h-3.5 w-3.5" /> Upload DNS CSV
                                </Button>
                              </ButtonGroup>
                            </div>

                            <div className="overflow-hidden rounded-md border border-border bg-card">
                              <table className="w-full text-small">
                                <thead className="bg-muted/40">
                                  <tr className="border-b border-border">
                                    <th scope="col" className="w-9 px-3 py-1.5 text-left">
                                      <Checkbox
                                        aria-label="Select all in pool"
                                        checked={selected.size === assigned.length && assigned.length > 0}
                                        onCheckedChange={() =>
                                          setSelected(
                                            selected.size === assigned.length
                                              ? new Set()
                                              : new Set(assigned.map((d) => d.id)),
                                          )
                                        }
                                      />
                                    </th>
                                    <th className="px-3 py-1.5 text-left text-micro font-medium uppercase tracking-wider text-muted-foreground">
                                      Domain
                                    </th>
                                    <th className="px-3 py-1.5 text-left text-micro font-medium uppercase tracking-wider text-muted-foreground">
                                      A-record
                                    </th>
                                    <th className="px-3 py-1.5 text-left text-micro font-medium uppercase tracking-wider text-muted-foreground">
                                      SSL mode
                                    </th>
                                    <th className="px-3 py-1.5 text-left text-micro font-medium uppercase tracking-wider text-muted-foreground">
                                      Always HTTPS
                                    </th>
                                    <th className="px-3 py-1.5 text-left text-micro font-medium uppercase tracking-wider text-muted-foreground">
                                      Status
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {assigned.map((d) => (
                                    <tr
                                      key={d.id}
                                      className={cn(
                                        "border-b border-border/60 last:border-b-0 hover:bg-muted/30",
                                        selected.has(d.id) && "bg-primary/5",
                                      )}
                                    >
                                      <td className="px-3 py-2">
                                        <Checkbox
                                          aria-label={`Select ${d.name}`}
                                          checked={selected.has(d.id)}
                                          onCheckedChange={() => toggleDomain(d.id)}
                                        />
                                      </td>
                                      <td className="px-3 py-2">
                                        <div className="flex items-center gap-2">
                                          <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                                          <span className="font-medium">{d.name}</span>
                                        </div>
                                      </td>
                                      <td className="px-3 py-2">
                                        <MonoCode>{d.ip}</MonoCode>
                                      </td>
                                      <td className="px-3 py-2 text-foreground/90">Strict</td>
                                      <td className="px-3 py-2">
                                        <StatusBadge status="completed" label="On" />
                                      </td>
                                      <td className="px-3 py-2">
                                        <StatusBadge status={d.status} />
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>

                            {selected.size > 0 && (
                              <div
                                role="toolbar"
                                aria-label="Bulk actions for assigned domains"
                                className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2"
                              >
                                <button
                                  onClick={() => setSelected(new Set())}
                                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                                  aria-label="Clear selection"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                                <span className="text-[13px] font-medium">
                                  {selected.size} {selected.size === 1 ? "domain" : "domains"} selected
                                </span>
                                <span className="mx-1 h-4 w-px bg-border" aria-hidden />
                                <ButtonGroup>
                                  <Button size="sm" variant="outline">Set A-record</Button>
                                  <Button size="sm" variant="outline">SSL mode</Button>
                                  <Button size="sm" variant="outline">Toggle Always HTTPS</Button>
                                </ButtonGroup>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </DataTable>
        </DataTableShell>
      </div>
    </AppShell>
  )
}
