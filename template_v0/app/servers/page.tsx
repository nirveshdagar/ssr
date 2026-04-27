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
  CloudDownload,
  AlertTriangle,
  X,
  ServerOff,
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
import { useServers } from "@/hooks/use-servers"
import { serverActions } from "@/lib/api-actions"
import { OperatorDialog } from "@/components/ssr/operator-dialog"
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field"
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

// Same regions Flask exposes in templates/servers.html
const DO_REGIONS = [
  { value: "nyc1", label: "NYC1 — New York" },
  { value: "nyc3", label: "NYC3 — New York" },
  { value: "sfo2", label: "SFO2 — San Francisco" },
  { value: "sfo3", label: "SFO3 — San Francisco" },
  { value: "ams3", label: "AMS3 — Amsterdam" },
  { value: "lon1", label: "LON1 — London" },
  { value: "fra1", label: "FRA1 — Frankfurt" },
  { value: "sgp1", label: "SGP1 — Singapore" },
] as const

const DO_SIZES = [
  { value: "s-1vcpu-1gb",            label: "s-1vcpu-1gb · $6/mo" },
  { value: "s-1vcpu-2gb",            label: "s-1vcpu-2gb · $12/mo" },
  { value: "s-2vcpu-2gb",            label: "s-2vcpu-2gb · $18/mo" },
  { value: "s-2vcpu-4gb",            label: "s-2vcpu-4gb · $24/mo" },
  { value: "s-2vcpu-8gb-160gb-intel", label: "s-2vcpu-8gb-160gb-intel · $48/mo (project default)" },
  { value: "s-4vcpu-8gb",            label: "s-4vcpu-8gb · $48/mo" },
] as const

export default function ServersPage() {
  const [query, setQuery] = React.useState("")
  const [statusFilter, setStatusFilter] = React.useState<"all" | "active" | "dead" | "migrating">("all")
  const { rows: SERVERS, refresh } = useServers()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [flash, setFlash] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)

  function show(kind: "ok" | "err", text: string) {
    setFlash({ kind, text })
    window.setTimeout(() => setFlash(null), 5500)
  }

  // Migrate-now modal — now captures the source server's name/IP/site-count
  // so the dialog can show "Move N domain(s) from `name` (`ip`)…" like Flask.
  const [migrateSource, setMigrateSource] = React.useState<
    { id: number; name: string; ip: string; sites: number } | null
  >(null)
  const [migrateTarget, setMigrateTarget] = React.useState<string>("")
  const [migrateResult, setMigrateResult] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)
  function openMigrate(s: { id: number; name: string; ip: string; sites: number }) {
    setMigrateSource(s); setMigrateTarget(""); setMigrateResult(null)
  }
  // Backwards-compat alias used by the old call sites — kept narrow.
  const migrateId = migrateSource?.id ?? null
  async function submitMigrate() {
    if (migrateId == null) return
    const target = migrateTarget && /^\d+$/.test(migrateTarget) ? Number(migrateTarget) : undefined
    const r = await serverActions.migrateNow(migrateId, target)
    if (r.ok) {
      setMigrateSource(null); show("ok", r.message ?? "Migration started")
      await refresh()
    } else {
      setMigrateResult({ kind: "err", text: r.error ?? r.message ?? "migrate failed" })
    }
  }
  async function markDead(id: number) {
    if (!confirm(`Mark server #${id} DEAD? Migrate Now is a separate action.`)) return
    setBusy(`d-${id}`)
    const r = await serverActions.markDead(id)
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
    await refresh(); setBusy(null)
  }
  async function markReady(id: number) {
    setBusy(`r-${id}`)
    const r = await serverActions.markReady(id)
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
    await refresh(); setBusy(null)
  }
  // Edit modal state
  const [editingId, setEditingId] = React.useState<number | null>(null)
  const [editName, setEditName] = React.useState("")
  const [editMax, setEditMax] = React.useState("")
  const [editResult, setEditResult] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)

  function openEdit(id: number, name: string, capacity: number) {
    setEditingId(id); setEditName(name); setEditMax(String(capacity)); setEditResult(null)
  }
  async function submitEdit() {
    if (editingId == null) return
    const max = Number(editMax)
    if (!Number.isFinite(max)) { setEditResult({ kind: "err", text: "max_sites must be a number" }); return }
    if (editName.length < 1 || editName.length > 64) {
      setEditResult({ kind: "err", text: "name must be 1-64 characters" }); return
    }
    if (max < 1 || max > 500) {
      setEditResult({ kind: "err", text: "max_sites must be between 1 and 500" }); return
    }
    const r = await serverActions.edit(editingId, editName, max)
    if (r.ok) {
      setEditingId(null)
      show("ok", r.message ?? "Server updated")
      await refresh()
    } else {
      setEditResult({ kind: "err", text: r.error ?? r.message ?? "edit failed" })
    }
  }
  async function dbDelete(id: number) {
    if (!confirm(`Soft-delete server #${id} from dashboard? DO droplet untouched.`)) return
    setBusy(`x-${id}`)
    const r = await serverActions.dbDelete(id)
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
    await refresh(); setBusy(null)
  }
  // Destroy-all modal — typed-name confirmation
  const [destroyOpen, setDestroyOpen] = React.useState(false)
  const [destroyPhrase, setDestroyPhrase] = React.useState("")
  const [destroyResult, setDestroyResult] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)
  function openDestroy() { setDestroyOpen(true); setDestroyPhrase(""); setDestroyResult(null) }
  async function submitDestroy() {
    if (destroyPhrase !== "DESTROY ALL") {
      setDestroyResult({ kind: "err", text: "Phrase must match exactly: DESTROY ALL" })
      return
    }
    const r = await serverActions.destroyAll(destroyPhrase)
    if (r.ok) {
      setDestroyOpen(false); show("ok", r.message ?? "Destroy-all started")
      await refresh()
    } else {
      setDestroyResult({ kind: "err", text: r.error ?? "destroy failed" })
    }
  }
  async function syncDo() {
    if (!confirm(
      "Remove dashboard rows whose DO droplet no longer exists upstream?\n\n" +
      "Rows with referencing domains stay (you'd lose pipeline state).",
    )) return
    setBusy("sync-do")
    const r = await serverActions.syncFromDo()
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
    await refresh(); setBusy(null)
  }
  async function importDo() {
    if (!confirm("Pull every droplet from your DigitalOcean account and add any we don't already have?")) return
    setBusy("import-do")
    const r = await serverActions.importFromDo() as
      { ok?: boolean; added?: number; skipped?: number; total?: number; message?: string; error?: string }
    if (r.ok) {
      show("ok", r.message ?? `Imported ${r.added ?? 0} droplet(s) (skipped ${r.skipped ?? 0} of ${r.total ?? 0})`)
    } else {
      show("err", r.error ?? "Import failed")
    }
    await refresh(); setBusy(null)
  }

  // Hard-delete dialog — typed-name confirm, lists what will be destroyed.
  const [destroyServer, setDestroyServer] = React.useState<
    { id: number; name: string; ip: string; dropletId: string; saId: string } | null
  >(null)
  const [destroyName, setDestroyName] = React.useState("")
  const [destroyOneResult, setDestroyOneResult] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)
  function openHardDelete(s: { id: number; name: string; ip: string; dropletId: string; saId: string }) {
    setDestroyServer(s); setDestroyName(""); setDestroyOneResult(null)
  }
  async function submitHardDelete() {
    if (!destroyServer) return
    if (destroyName !== destroyServer.name) {
      setDestroyOneResult({
        kind: "err",
        text: `Typed name doesn't match. Got '${destroyName}', expected '${destroyServer.name}'.`,
      })
      return
    }
    const r = await serverActions.delete(destroyServer.id, destroyName)
    if (r.ok) {
      setDestroyServer(null); show("ok", r.message ?? "Server destroyed")
      await refresh()
    } else {
      setDestroyOneResult({ kind: "err", text: r.error ?? r.message ?? "destroy failed" })
    }
  }

  // New Droplet modal — region + size dropdowns
  const [newOpen, setNewOpen] = React.useState(false)
  const [newName, setNewName] = React.useState("")
  const [newRegion, setNewRegion] = React.useState("nyc1")
  const [newSize, setNewSize] = React.useState("s-2vcpu-8gb-160gb-intel")
  const [newResult, setNewResult] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)
  function openNewDroplet() {
    setNewOpen(true)
    setNewName(`ssr-${Math.floor(Date.now() / 1000)}`)
    setNewRegion("nyc1"); setNewSize("s-2vcpu-8gb-160gb-intel"); setNewResult(null)
  }
  async function submitNewDroplet() {
    if (!newName.trim()) { setNewResult({ kind: "err", text: "Name is required" }); return }
    const r = await serverActions.create({ name: newName.trim(), region: newRegion, size: newSize })
    if (r.ok) {
      setNewOpen(false); show("ok", r.message ?? "Droplet creation enqueued")
      await refresh()
    } else {
      setNewResult({ kind: "err", text: r.error ?? r.message ?? "create failed" })
    }
  }

  // Add Existing Server modal — name + ip + sa_server_id
  const [addOpen, setAddOpen] = React.useState(false)
  const [addFields, setAddFields] = React.useState<{ name: string; ip: string; sa: string }>(
    { name: "", ip: "", sa: "" },
  )
  const [addResult, setAddResult] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)
  function openAddExisting() { setAddOpen(true); setAddFields({ name: "", ip: "", sa: "" }); setAddResult(null) }
  async function submitAddExisting() {
    if (!addFields.name.trim() || !addFields.ip.trim()) {
      setAddResult({ kind: "err", text: "Name and IP are required" }); return
    }
    const r = await serverActions.addExisting(
      addFields.name.trim(), addFields.ip.trim(), addFields.sa.trim() || undefined,
    )
    if (r.ok) {
      setAddOpen(false); show("ok", r.message ?? "Server added")
      await refresh()
    } else {
      setAddResult({ kind: "err", text: r.error ?? r.message ?? "add failed" })
    }
  }

  const filtered = SERVERS.filter((s) => {
    if (statusFilter !== "all" && s.status !== statusFilter) return false
    if (!query) return true
    const q = query.toLowerCase()
    return (
      s.name.toLowerCase().includes(q) ||
      s.region.toLowerCase().includes(q) ||
      s.ip.includes(query) ||
      s.doDropletId.includes(query) ||
      s.saServerId.includes(query)
    )
  })
  const statusCount = (k: typeof statusFilter) =>
    k === "all" ? SERVERS.length : SERVERS.filter((s) => s.status === k).length

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
          {/* Import-from-DO — pull every droplet on the DO account, add any we
              don't already have. Was missing from the new dashboard entirely. */}
          <Button
            variant="outline" size="sm"
            className="gap-1.5 hidden sm:inline-flex btn-soft-info"
            onClick={importDo} disabled={busy === "import-do"}
            title="Pull every droplet from your DigitalOcean account — adds rows for any we don't have yet"
          >
            <CloudDownload className="h-3.5 w-3.5" /> Import from DO
          </Button>
          {/* Sync-from-DO — drop dashboard rows whose DO droplet was destroyed elsewhere. */}
          <Button
            variant="outline" size="sm"
            className="gap-1.5 hidden sm:inline-flex btn-soft-warning"
            onClick={syncDo} disabled={busy === "sync-do"}
            title="Drop dashboard rows whose DO droplet no longer exists upstream"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", busy === "sync-do" && "animate-spin")} /> Sync from DO
          </Button>
          <Button
            variant="outline" size="sm"
            className="gap-1.5 hidden sm:inline-flex"
            onClick={openAddExisting}
            title="Manually register a server you already provisioned (provides name + IP + optional SA id)"
          >
            <Download className="h-3.5 w-3.5" /> Add existing
          </Button>
          <Button
            variant="outline" size="sm"
            className="gap-1.5 hidden sm:inline-flex text-status-terminal hover:text-status-terminal"
            onClick={openDestroy}
            title="Emergency kill-switch — destroys every server with no domain references"
          >
            <Trash2 className="h-3.5 w-3.5" /> Destroy all
          </Button>
          <Button
            size="sm" className="gap-1.5 btn-success"
            onClick={openNewDroplet}
            title="Provision a new DO droplet + auto-install ServerAvatar agent"
          >
            <Plus className="h-3.5 w-3.5" /> New droplet
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
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

        {SERVERS.length === 0 ? (
          <div className="rounded-md border border-border bg-card flex flex-col items-center justify-center py-12 gap-3">
            <ServerOff className="h-8 w-8 text-muted-foreground" aria-hidden />
            <p className="text-small text-muted-foreground">No servers configured</p>
            <div className="flex gap-2">
              <Button size="sm" className="gap-1.5 btn-success" onClick={openNewDroplet}
                title="Provision a fresh droplet on DigitalOcean"
              >
                <Plus className="h-3.5 w-3.5" /> New droplet
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 btn-soft-info" onClick={importDo}
                title="Pull existing droplets from DigitalOcean"
              >
                <CloudDownload className="h-3.5 w-3.5" /> Import from DO
              </Button>
            </div>
          </div>
        ) : (
        <DataTableShell>
          <DataTableToolbar>
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, region, IP, DO id, or SA id…"
                className="h-8 pl-8 text-small"
              />
            </div>
            <ButtonGroup>
              {(["all", "active", "dead", "migrating"] as const).map((k) => {
                const active = statusFilter === k
                return (
                  <Button
                    key={k}
                    variant={active ? "outline" : "ghost"}
                    size="sm"
                    className={cn("gap-1.5 capitalize", active && "btn-soft-info")}
                    onClick={() => setStatusFilter(k)}
                    title={k === "all" ? "Show every server" : `Show only ${k} servers`}
                  >
                    {k}
                    <span className={cn(
                      "rounded px-1 py-px text-micro tabular-nums",
                      active ? "bg-status-running/15 text-status-running" : "bg-muted text-muted-foreground",
                    )}>
                      {statusCount(k)}
                    </span>
                  </Button>
                )
              })}
            </ButtonGroup>
            {(query || statusFilter !== "all") && (
              <Button
                variant="outline" size="sm" className="gap-1.5"
                onClick={() => { setQuery(""); setStatusFilter("all") }}
                title="Clear search + status filter"
              >
                <X className="h-3.5 w-3.5" /> Clear
              </Button>
            )}
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
                      <code className="font-mono text-micro text-muted-foreground">{s.size}</code>
                    </DataTableCell>
                    <DataTableCell>
                      <MonoCode>{s.ip}</MonoCode>
                    </DataTableCell>
                    <DataTableCell>
                      <span className="font-mono tabular-nums">{s.domains}</span>
                    </DataTableCell>
                    <DataTableCell>
                      <div className="flex items-center gap-2 min-w-[120px]" title={`${s.domains}/${s.capacity} sites · DO ${s.doDropletId || "—"} · SA ${s.saServerId || "—"}`}>
                        <span
                          className={cn(
                            "font-mono text-micro tabular-nums w-9 text-right",
                            pct >= 95 ? "text-status-terminal" : pct >= 75 ? "text-status-waiting" : "text-muted-foreground",
                          )}
                        >
                          {pct}%
                        </span>
                        <div className="relative h-1.5 flex-1 max-w-[80px] overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              pct >= 95 ? "bg-status-terminal" : pct >= 75 ? "bg-status-waiting" : "bg-status-completed",
                            )}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    </DataTableCell>
                    <DataTableCell align="right">
                      <span className="font-mono text-micro text-muted-foreground">{s.createdAt}</span>
                    </DataTableCell>
                    <DataTableCell align="right">
                      <ButtonGroup className="justify-end">
                        {/* Migrate button only when this server actually hosts something —
                            mirrors Flask servers.html line 56-67's {% if (s.sites_count or 0) > 0 %}
                            so we don't surface a no-op action on empty servers. */}
                        {s.domains > 0 && (
                          <Button
                            variant="ghost" size="icon" className="h-7 w-7 text-status-running"
                            aria-label="Migrate"
                            title={`Migrate all ${s.domains} domain(s) off ${s.name} — uses cached SSL + content archive, no LLM regen`}
                            onClick={() => openMigrate({ id: Number(s.id), name: s.name, ip: s.ip, sites: s.domains })}
                          >
                            <ArrowLeftRight className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {s.status === "dead" ? (
                          <Button
                            variant="ghost" size="icon" className="h-7 w-7 text-status-completed"
                            aria-label="Mark ready"
                            title="False positive — restore to ready and reset down-streaks"
                            disabled={busy === `r-${s.id}`}
                            onClick={() => markReady(Number(s.id))}
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost" size="icon" className="h-7 w-7 text-status-waiting"
                            aria-label="Mark dead"
                            title="Force-mark this server as dead (bypasses the auto-detector's 10-tick threshold)"
                            disabled={busy === `d-${s.id}`}
                            onClick={() => markDead(Number(s.id))}
                          >
                            <XCircle className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          variant="ghost" size="icon" className="h-7 w-7"
                          aria-label="Edit"
                          title="Edit name + max_sites (how many domains can host here)"
                          onClick={() => openEdit(Number(s.id), s.name, s.capacity)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost" size="icon" className="h-7 w-7 text-status-waiting"
                          aria-label="Soft delete"
                          title="Soft delete — remove from dashboard only (DO droplet + SA record keep running)"
                          disabled={busy === `x-${s.id}`}
                          onClick={() => dbDelete(Number(s.id))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost" size="icon" className="h-7 w-7 text-status-terminal"
                          aria-label="Hard delete"
                          title="Hard delete — destroy DO droplet + SA record + DB row (typed-name confirm)"
                          onClick={() => openHardDelete({
                            id: Number(s.id), name: s.name, ip: s.ip,
                            dropletId: s.doDropletId, saId: s.saServerId,
                          })}
                        >
                          <AlertTriangle className="h-3.5 w-3.5" />
                        </Button>
                        <ButtonGroupSeparator />
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost" size="icon" className="h-7 w-7"
                              aria-label="More actions" title="More actions — view domains hosted on this server"
                            >
                              <ChevronDown className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem onClick={() => window.location.assign(`/domains?server=${s.id}`)}>
                              View domains hosted here
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </ButtonGroup>
                    </DataTableCell>
                  </DataTableRow>
                )
              })}
              {filtered.length === 0 && SERVERS.length > 0 && (
                <tr>
                  <td colSpan={9} className="text-center text-muted-foreground py-8 text-small">
                    No servers match the current filter.
                  </td>
                </tr>
              )}
            </tbody>
          </DataTable>
        </DataTableShell>
        )}
      </div>

      <OperatorDialog
        open={editingId !== null}
        onOpenChange={(o) => { if (!o) setEditingId(null) }}
        title={`Edit server #${editingId ?? ""}`}
        description="Mutable: display name and per-server site cap. Email + IP + DO id are not editable here."
        submitLabel="Save"
        onSubmit={submitEdit}
        resultMessage={editResult?.text ?? null}
        resultKind={editResult?.kind ?? null}
      >
        <Field>
          <FieldLabel>Server name</FieldLabel>
          <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="ssr-server-12" />
          <FieldDescription>1–64 characters.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Max sites</FieldLabel>
          <Input
            type="number" value={editMax}
            onChange={(e) => setEditMax(e.target.value)}
            placeholder="60"
          />
          <FieldDescription>Capacity ceiling; pipeline step 6 picks servers below this. 1–500.</FieldDescription>
        </Field>
      </OperatorDialog>

      {/* New Droplet modal */}
      <OperatorDialog
        open={newOpen} onOpenChange={setNewOpen}
        title="New DigitalOcean droplet"
        description="Provisions via DO API + installs SA agent. Takes 5–15 min; progress in /logs and the watcher."
        submitLabel="Create"
        onSubmit={submitNewDroplet}
        resultMessage={newResult?.text ?? null}
        resultKind={newResult?.kind ?? null}
      >
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="ssr-server-N" />
        </Field>
        <Field>
          <FieldLabel>Region</FieldLabel>
          <Select value={newRegion} onValueChange={setNewRegion}>
            <SelectTrigger size="sm" className="h-8 text-small"><SelectValue /></SelectTrigger>
            <SelectContent>
              {DO_REGIONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>Size</FieldLabel>
          <Select value={newSize} onValueChange={setNewSize}>
            <SelectTrigger size="sm" className="h-8 text-small"><SelectValue /></SelectTrigger>
            <SelectContent>
              {DO_SIZES.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </OperatorDialog>

      {/* Add Existing Server modal */}
      <OperatorDialog
        open={addOpen} onOpenChange={setAddOpen}
        title="Add existing server"
        description="Manual hardware registration. Useful for servers provisioned outside DO or already wired to ServerAvatar."
        submitLabel="Add"
        onSubmit={submitAddExisting}
        resultMessage={addResult?.text ?? null}
        resultKind={addResult?.kind ?? null}
      >
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input value={addFields.name} onChange={(e) => setAddFields((s) => ({ ...s, name: e.target.value }))} />
        </Field>
        <Field>
          <FieldLabel>IP</FieldLabel>
          <Input value={addFields.ip} onChange={(e) => setAddFields((s) => ({ ...s, ip: e.target.value }))} placeholder="1.2.3.4" />
        </Field>
        <Field>
          <FieldLabel>ServerAvatar ID (optional)</FieldLabel>
          <Input value={addFields.sa} onChange={(e) => setAddFields((s) => ({ ...s, sa: e.target.value }))} placeholder="leave blank if not wired up yet" />
          <FieldDescription>If set, server is marked status=&quot;ready&quot; immediately.</FieldDescription>
        </Field>
      </OperatorDialog>

      {/* Migrate Now modal — Flask-parity: shows source name/IP/site count */}
      <OperatorDialog
        open={migrateSource !== null}
        onOpenChange={(o) => { if (!o) setMigrateSource(null) }}
        title="Migrate Server"
        description={
          "Moves every domain on this server to a target server. Auto-pick won't pick the server " +
          "being migrated off. The source row itself is NOT destroyed — delete it separately after verifying."
        }
        submitLabel="Start migration"
        onSubmit={submitMigrate}
        resultMessage={migrateResult?.text ?? null}
        resultKind={migrateResult?.kind ?? null}
      >
        {migrateSource && (
          <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-small">
            Move <strong>{migrateSource.sites}</strong> domain(s) from{" "}
            <code className="font-mono text-foreground">{migrateSource.name}</code>{" "}
            (<code className="font-mono text-foreground">{migrateSource.ip}</code>) to a new server.
          </div>
        )}
        <ul className="text-micro text-muted-foreground list-disc pl-5 space-y-0.5">
          <li>Uses cached Origin SSL cert (15y) — no CF re-issue needed</li>
          <li>Uses local content archive — no LLM regen cost</li>
          <li>PATCHes CF A-records directly (nameservers unchanged)</li>
          <li>Per-domain heartbeat in Watcher while migrating</li>
        </ul>
        <Field>
          <FieldLabel>Target server (optional)</FieldLabel>
          <Select
            value={migrateTarget || "__auto__"}
            onValueChange={(v) => setMigrateTarget(v === "__auto__" ? "" : v)}
          >
            <SelectTrigger size="sm" className="h-8 text-small"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__auto__">Auto — pick ready server or provision fresh droplet</SelectItem>
              {SERVERS.filter((s) => Number(s.id) !== migrateId && s.status === "active").map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  #{s.id} — {s.name} ({s.ip}) · {s.domains}/{s.capacity}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            Leaving this empty is safest — auto-mode won&apos;t pick the server being migrated off.
          </FieldDescription>
        </Field>
      </OperatorDialog>

      {/* Destroy All modal — typed-name confirmation */}
      <OperatorDialog
        open={destroyOpen} onOpenChange={setDestroyOpen}
        title="Destroy ALL servers"
        description="Tears down every server with NO domain references. DO droplets get DELETE'd, SA server records dropped, local rows removed. Servers that still host domains are skipped."
        submitLabel="DESTROY"
        submitVariant="destructive"
        onSubmit={submitDestroy}
        resultMessage={destroyResult?.text ?? null}
        resultKind={destroyResult?.kind ?? null}
      >
        <Field>
          <FieldLabel>
            Type the phrase <code className="font-mono">DESTROY ALL</code> to confirm
          </FieldLabel>
          <Input
            value={destroyPhrase}
            onChange={(e) => setDestroyPhrase(e.target.value)}
            placeholder="DESTROY ALL"
            className="font-mono"
          />
          <FieldDescription className="text-status-terminal">
            This is irreversible. Domains attached to a server prevent its destruction; only orphaned servers are torn down.
          </FieldDescription>
        </Field>
      </OperatorDialog>

      {/* Hard-delete one server modal — Flask parity, typed-name confirm */}
      <OperatorDialog
        open={destroyServer !== null}
        onOpenChange={(o) => { if (!o) setDestroyServer(null) }}
        title="Destroy Server"
        description="Permanent — destroys the DO droplet (stops billing), removes the SA record, and drops the dashboard row. Refused if any domain still references this server."
        submitLabel={destroyServer ? `Destroy ${destroyServer.name}` : "Destroy"}
        submitVariant="destructive"
        onSubmit={submitHardDelete}
        resultMessage={destroyOneResult?.text ?? null}
        resultKind={destroyOneResult?.kind ?? null}
      >
        {destroyServer && (
          <div className="rounded-md border border-status-terminal/30 bg-status-terminal/8 px-3 py-2 text-small flex flex-col gap-1.5">
            <div className="flex items-center gap-2 font-medium text-status-terminal">
              <AlertTriangle className="h-4 w-4" aria-hidden /> This will permanently:
            </div>
            <ul className="text-micro text-foreground/80 list-disc pl-5 space-y-0.5">
              <li>
                Destroy DO droplet{" "}
                <code className="font-mono">{destroyServer.dropletId || "—"}</code> (stops billing)
              </li>
              <li>
                Remove SA server <code className="font-mono">{destroyServer.saId || "—"}</code> from the ServerAvatar org
              </li>
              <li>Drop this row from the SSR dashboard DB</li>
            </ul>
            <div className="text-micro text-muted-foreground mt-1">
              Will refuse if any domain still has this server assigned — delete those first.
            </div>
          </div>
        )}
        <Field>
          <FieldLabel>
            Type the server name{" "}
            <code className="font-mono text-status-terminal">{destroyServer?.name ?? ""}</code> to confirm
          </FieldLabel>
          <Input
            value={destroyName}
            onChange={(e) => setDestroyName(e.target.value)}
            placeholder="server name"
            className="font-mono"
            autoComplete="off"
            autoFocus
          />
          <FieldDescription className="text-status-terminal">
            Submit stays disabled until the typed name matches exactly.
          </FieldDescription>
        </Field>
      </OperatorDialog>
    </AppShell>
  )
}
