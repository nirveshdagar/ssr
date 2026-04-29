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
  Trash2,
  ShieldCheck,
  Zap,
  MoreHorizontal,
  X,
  Eye,
  EyeOff,
  Info,
  CloudOff,
  FileUp,
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
import { useCfKeys } from "@/hooks/use-cf-keys"
import { cfKeyActions } from "@/lib/api-actions"
import { OperatorDialog } from "@/components/ssr/operator-dialog"
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

interface TestZoneResult {
  ok?: boolean
  test_zone_name?: string
  zone_id?: string
  nameservers?: string[]
  initial_status?: string
  cleanup?: { deleted: boolean; error: string | null; orphan_zone_id: string | null }
  message?: string
  error?: string
  stage?: string
}

interface ZonesListZone {
  cf_zone_id: string
  name: string
  cf_status: string
  cf_type: string | null
  cf_paused: boolean
  cf_created: string | null
  tracked: boolean
  ssr_domain_status: string | null
  ssr_zone_id_match: boolean | null
}

interface ZonesListResult {
  ok: boolean
  key_alias?: string | null
  cf_account_id?: string
  zones?: ZonesListZone[]
  tracked_missing_in_cf?: { domain: string; cf_zone_id: string | null; ssr_status: string; reason: string }[]
  total_in_cf?: number
  total_tracked?: number
  error?: string
}

export default function CloudflarePage() {
  const [expanded, setExpanded] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  // Row-level checkbox selection of CF KEYS (separate from `selected` which
  // tracks selected DOMAINS within an expanded key's panel for the bulk
  // IP / SSL forms).
  const [keysSelected, setKeysSelected] = React.useState<Set<number>>(new Set())
  const { rows: CF_KEYS, domainsByKey, refresh } = useCfKeys()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [flash, setFlash] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)
  const [search, setSearch] = React.useState("")

  function show(kind: "ok" | "err", text: string) {
    setFlash({ kind, text })
    window.setTimeout(() => setFlash(null), 5500)
  }

  // ---- Add CF key dialog ----
  const [addOpen, setAddOpen] = React.useState(false)
  const [addEmail, setAddEmail] = React.useState("")
  const [addApiKey, setAddApiKey] = React.useState("")
  const [addAlias, setAddAlias] = React.useState("")
  const [showApiKey, setShowApiKey] = React.useState(false)
  const [addResult, setAddResult] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)

  function openAdd() {
    setAddEmail(""); setAddApiKey(""); setAddAlias(""); setShowApiKey(false)
    setAddResult(null); setAddOpen(true)
  }
  async function submitAdd() {
    if (!addEmail.trim() || !addApiKey.trim()) {
      setAddResult({ kind: "err", text: "Email + Global API Key are both required" }); return
    }
    const r = await cfKeyActions.add(addEmail.trim(), addApiKey.trim(), addAlias.trim() || undefined)
    if (r.ok) {
      setAddOpen(false); show("ok", r.message ?? "Added"); await refresh()
    } else {
      setAddResult({ kind: "err", text: r.error ?? r.message ?? "Add failed" })
    }
  }

  // ---- Refresh-accounts confirmation ----
  async function refreshAccounts() {
    if (!confirm("Re-fetch the real Account ID for every CF key in the pool?")) return
    setBusy("refresh")
    const r = await cfKeyActions.refreshAccounts() as
      { ok?: boolean; summary?: { total: number; changed: number; errored: number }; error?: string }
    if (r.ok && r.summary) {
      show("ok",
        `Refreshed ${r.summary.total} key(s) — ${r.summary.changed} changed, ${r.summary.errored} errored`,
      )
    } else {
      show("err", r.error ?? "Refresh failed")
    }
    await refresh(); setBusy(null)
  }

  async function toggleKey(id: number, isActive: boolean) {
    const verb = isActive ? "Pause" : "Activate"
    if (!confirm(`${verb} CF key #${id}? ${isActive
      ? "Paused keys won't be picked for new domain assignments."
      : "Will become eligible for new domain assignments again."}`)) return
    setBusy(`t-${id}`)
    const r = await cfKeyActions.toggle(id)
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? `${verb}d`)
    await refresh(); setBusy(null)
  }

  // ---- Edit CF key modal ----
  const [editingKey, setEditingKey] = React.useState<{ id: number; alias: string; max: string } | null>(null)
  const [editKeyResult, setEditKeyResult] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)

  function openEditKey(id: number, alias: string, max: number) {
    setEditingKey({ id, alias, max: String(max) })
    setEditKeyResult(null)
  }
  async function submitEditKey() {
    if (!editingKey) return
    const max = Number(editingKey.max)
    if (!Number.isFinite(max)) { setEditKeyResult({ kind: "err", text: "max_domains must be a number" }); return }
    if (max < 1 || max > 1000) { setEditKeyResult({ kind: "err", text: "max_domains must be between 1 and 1000" }); return }
    const r = await cfKeyActions.edit(editingKey.id, editingKey.alias || null, max)
    if (r.ok) {
      setEditingKey(null); show("ok", r.message ?? "Updated"); await refresh()
    } else {
      setEditKeyResult({ kind: "err", text: r.error ?? r.message ?? "edit failed" })
    }
  }

  // ---- Test create zone diagnostic ----
  const [testZone, setTestZone] = React.useState<
    { id: number; label: string; running: boolean; result: TestZoneResult | null } | null
  >(null)
  async function runTestZone(keyId: number, label: string) {
    setTestZone({ id: keyId, label, running: true, result: null })
    const r = await cfKeyActions.testCreateZone(keyId) as TestZoneResult
    setTestZone((s) => s ? { ...s, running: false, result: r } : s)
  }

  // ---- Zones-in-CF list dialog ----
  const [zonesListKey, setZonesListKey] = React.useState<{ id: number; label: string } | null>(null)
  const [zonesListData, setZonesListData] = React.useState<ZonesListResult | null>(null)
  const [zonesListLoading, setZonesListLoading] = React.useState(false)
  async function openZonesList(keyId: number, label: string) {
    setZonesListKey({ id: keyId, label })
    setZonesListData(null)
    setZonesListLoading(true)
    const r = await cfKeyActions.listZones(keyId)
    setZonesListLoading(false)
    if (r.ok && r.data) {
      setZonesListData(r.data as ZonesListResult)
    } else {
      setZonesListData({ ok: false, error: r.error ?? "list zones failed" } as ZonesListResult)
    }
  }

  // ---- Bulk DNS CSV modal — supports paste OR file upload (Flask parity) ----
  const [csvKey, setCsvKey] = React.useState<{ id: number; label: string } | null>(null)
  const [csvText, setCsvText] = React.useState("")
  const [csvFile, setCsvFile] = React.useState<File | null>(null)
  const [csvResult, setCsvResult] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)

  function openCsvModal(keyId: number, label: string) {
    setCsvKey({ id: keyId, label })
    setCsvText("domain,type,name,content,proxied,ttl\n")
    setCsvFile(null)
    setCsvResult(null)
  }
  async function submitCsv() {
    if (!csvKey) return
    const text = csvText.trim() === "domain,type,name,content,proxied,ttl" ? "" : csvText
    if (!text.trim() && !csvFile) {
      setCsvResult({ kind: "err", text: "Provide CSV content (paste or upload a .csv file)" }); return
    }
    const r = await cfKeyActions.bulkDnsCsv(csvKey.id, text, csvFile) as
      { ok?: boolean; job_id?: number; valid?: number; skipped?: number;
        error?: string; errors?: { line: number; message: string }[] }
    if (r.ok) {
      setCsvKey(null)
      const skippedNote = r.skipped ? ` · ${r.skipped} skipped` : ""
      show("ok", `DNS bulk-upsert enqueued (job #${r.job_id}) — ${r.valid} valid row(s)${skippedNote}`)
      await refresh()
    } else {
      const errLines = (r.errors ?? []).slice(0, 3)
        .map((e) => `line ${e.line}: ${e.message}`).join("; ")
      setCsvResult({ kind: "err", text: r.error ?? errLines ?? "CSV submit failed" })
    }
  }

  async function deleteKey(id: number, label: string) {
    if (!confirm(
      `Delete CF key #${id} (${label}) from pool?\n\n` +
      `Will be refused if any domain still references it. ` +
      `Move those domains to another key first or soft-delete them.`,
    )) return
    setBusy(`d-${id}`)
    const r = await fetch(`/api/cf-keys/${id}`, { method: "DELETE", credentials: "same-origin" })
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; reason?: string; error?: string }
    show(j.ok ? "ok" : "err", j.reason ?? j.error ?? (j.ok ? "Deleted" : "Failed"))
    await refresh(); setBusy(null)
  }

  // ---- Lazy-fetched per-domain CF zone settings (SSL mode + Always-HTTPS) ----
  // CF settings live on the zone, not in our DB. We fetch them on demand
  // when the operator expands a key row + clicks "Load CF settings", then
  // cache per (keyId → domain) so re-expanding doesn't refetch.
  type ZoneSettingRow = {
    domain: string; ssl_mode: string | null;
    always_https: "on" | "off" | null; error: string | null
  }
  const [zoneSettings, setZoneSettings] = React.useState<Record<number, Record<string, ZoneSettingRow>>>({})
  const [zoneLoading, setZoneLoading] = React.useState<Record<number, boolean>>({})
  async function loadZoneSettings(keyId: number) {
    setZoneLoading((m) => ({ ...m, [keyId]: true }))
    try {
      const r = await fetch(`/api/cf-keys/${keyId}/zone-settings`, { credentials: "same-origin" })
      const j = (await r.json()) as { rows?: ZoneSettingRow[]; error?: string }
      if (!r.ok) { show("err", j.error ?? "Failed to load CF settings"); return }
      const byDomain: Record<string, ZoneSettingRow> = {}
      for (const row of j.rows ?? []) byDomain[row.domain] = row
      setZoneSettings((m) => ({ ...m, [keyId]: byDomain }))
      show("ok", `Loaded CF settings for ${(j.rows ?? []).length} domain(s)`)
    } finally {
      setZoneLoading((m) => ({ ...m, [keyId]: false }))
    }
  }

  // ---- Bulk add CF keys (CSV paste OR file upload) ----
  // CSV header: email,api_key,alias  (alias optional; `name` accepted as alias)
  const [bulkAddOpen, setBulkAddOpen] = React.useState(false)
  const [bulkAddText, setBulkAddText] = React.useState("")
  const [bulkAddFile, setBulkAddFile] = React.useState<File | null>(null)
  const [bulkAddResult, setBulkAddResult] = React.useState<
    { added: number; errored: number; results: { email: string; ok: boolean; error?: string }[] } | null
  >(null)
  function openBulkAdd() {
    setBulkAddText("")
    setBulkAddFile(null)
    setBulkAddResult(null)
    setBulkAddOpen(true)
  }
  async function submitBulkAdd() {
    if (!bulkAddFile && !bulkAddText.trim()) {
      show("err", "Paste CSV or pick a file first")
      return
    }
    setBusy("bulk-add")
    const r = await cfKeyActions.bulkAddCsv(bulkAddText, bulkAddFile ?? undefined) as
      { ok?: boolean; submitted?: number; added?: number; errored?: number;
        results?: { email: string; ok: boolean; error?: string }[]; error?: string; message?: string }
    if (!r.ok) {
      show("err", r.error ?? "Bulk add failed")
    } else {
      show(r.errored && r.errored > 0 ? "err" : "ok", r.message ?? "")
      setBulkAddResult({
        added: r.added ?? 0, errored: r.errored ?? 0, results: r.results ?? [],
      })
    }
    await refresh()
    setBusy(null)
  }

  // ---- Bulk delete CF keys (selected via row checkboxes) ----
  async function bulkDeleteKeys() {
    const ids = [...keysSelected]
    if (ids.length === 0) return
    if (!confirm(
      `Delete ${ids.length} CF key(s)?\n\n` +
      `Keys with referencing domains stay (can't strand a domain by yanking its key). ` +
      `Soft-delete those domains first if you really want the keys gone.`,
    )) return
    setBusy("bulk-del-keys")
    const r = await cfKeyActions.bulkDelete(ids) as
      { ok?: boolean; deleted?: number; blocked?: number; message?: string; error?: string;
        results?: { id: number; email?: string | null; alias?: string | null; ok: boolean; reason?: string }[] }
    if (!r.ok) {
      show("err", r.error ?? "Bulk delete failed")
    } else {
      const blocked = r.results?.filter((x) => !x.ok) ?? []
      const blockedDetail = blocked.length
        ? blocked.slice(0, 3)
            .map((x) => `${x.alias ?? x.email ?? x.id} — ${x.reason ?? "?"}`)
            .join(" · ") +
          (blocked.length > 3 ? ` (+${blocked.length - 3} more)` : "")
        : ""
      show(blocked.length ? "err" : "ok",
        (r.message ?? "") + (blockedDetail ? ` · ${blockedDetail}` : ""))
    }
    setKeysSelected(new Set())
    await refresh()
    setBusy(null)
  }

  // ---- Sync from CF — drift report across every active key ----
  // Walks the CF API for every active key, lists its zones, and surfaces
  // three classes of drift against the domains table:
  //   - SSR orphans (DB row claims cf_zone_id but CF doesn't list it)
  //   - CF zones not tracked in DB
  //   - Backfillable: DB cf_zone_id is null but a name match exists on CF
  //     (auto-fixed in place; the "completed" toast counts how many flipped)
  async function syncFromCf() {
    if (!confirm(
      "Walk every active CF key, list zones, and reconcile against the domains table?\n\n" +
      "Auto-fixes: backfills cf_zone_id when a name match exists on CF.\n" +
      "Reports (manual review): SSR rows whose CF zone is gone, and CF zones not tracked in DB.",
    )) return
    setBusy("cfsync")
    const r = await cfKeyActions.sync() as {
      ok?: boolean
      summary?: { keys_synced: number; ssr_orphans: number; cf_untracked: number; backfilled: number; errors: number }
      message?: string
      error?: string
    }
    if (!r.ok) {
      show("err", r.error ?? "Sync failed")
    } else {
      show("ok", r.message ?? "Sync complete")
    }
    await refresh(); setBusy(null)
  }

  // ---- Operator-initiated status refresh ----
  // Probes every hosted/live domain under a CF key once and flips status
  // based on the response. Decisive (single 2xx/3xx → live) because the
  // operator explicitly asked. Solves the gap when the background live-
  // checker is OFF (Flask-side default).
  const [statusRefreshing, setStatusRefreshing] = React.useState<Record<number, boolean>>({})
  async function refreshStatus(keyId: number) {
    setStatusRefreshing((m) => ({ ...m, [keyId]: true }))
    try {
      const r = await fetch(`/api/cf-keys/${keyId}/refresh-status`, {
        method: "POST", credentials: "same-origin",
      })
      const j = (await r.json()) as { ok?: boolean; message?: string; flipped?: number; error?: string }
      if (!r.ok || !j.ok) { show("err", j.error ?? "Status refresh failed"); return }
      show("ok", j.message ?? `Refreshed ${j.flipped ?? 0} flipped`)
      await refresh()
    } finally {
      setStatusRefreshing((m) => ({ ...m, [keyId]: false }))
    }
  }

  // ---- Per-key inline bulk forms (A-record / SSL+HTTPS) ----
  const [ipDraft, setIpDraft] = React.useState<{ keyId: number | null; ip: string; proxied: boolean }>(
    { keyId: null, ip: "", proxied: true },
  )
  const [sslDraft, setSslDraft] = React.useState<{ keyId: number | null; mode: string; alwaysHttps: string }>(
    { keyId: null, mode: "unchanged", alwaysHttps: "unchanged" },
  )

  async function submitBulkIp(keyId: number, domains: string[]) {
    if (!ipDraft.ip.trim()) { show("err", "Enter an IP first"); return }
    if (domains.length === 0) { show("err", "Pick at least one domain first"); return }
    if (!confirm(
      `Change A-records for ${domains.length} domain(s) to ${ipDraft.ip.trim()}? ` +
      `(${ipDraft.proxied ? "proxied" : "DNS-only — orange cloud OFF"})`,
    )) return
    setBusy(`bip-${keyId}`)
    const r = await cfKeyActions.bulkSetIp(keyId, domains, ipDraft.ip.trim(), ipDraft.proxied) as
      { ok?: boolean; job_id?: number; count?: number; error?: string }
    if (r.ok) {
      show("ok", `A-record change enqueued (job #${r.job_id}) — ${r.count} domain(s)`)
    } else {
      show("err", r.error ?? "Bulk IP change failed")
    }
    setIpDraft({ keyId: null, ip: "", proxied: true })
    setSelected(new Set()); await refresh(); setBusy(null)
  }
  async function submitBulkSsl(keyId: number, domains: string[]) {
    const settings: { ssl_mode?: string; always_https?: string } = {}
    if (sslDraft.mode && sslDraft.mode !== "unchanged") settings.ssl_mode = sslDraft.mode
    if (sslDraft.alwaysHttps && sslDraft.alwaysHttps !== "unchanged") settings.always_https = sslDraft.alwaysHttps
    if (Object.keys(settings).length === 0) { show("err", "Pick at least one setting to change"); return }
    if (domains.length === 0) { show("err", "Pick at least one domain first"); return }
    const parts: string[] = []
    if (settings.ssl_mode) parts.push(`SSL: ${settings.ssl_mode}`)
    if (settings.always_https) parts.push(`Always-HTTPS: ${settings.always_https}`)
    if (!confirm(`Apply ${parts.join(", ")} to ${domains.length} domain(s)?`)) return
    setBusy(`bssl-${keyId}`)
    const r = await cfKeyActions.bulkSetSettings(keyId, domains, settings) as
      { ok?: boolean; job_id?: number; count?: number; error?: string }
    if (r.ok) {
      show("ok", `Settings change enqueued (job #${r.job_id}) — ${r.count} domain(s)`)
    } else {
      show("err", r.error ?? "Bulk settings change failed")
    }
    setSslDraft({ keyId: null, mode: "unchanged", alwaysHttps: "unchanged" })
    setSelected(new Set()); await refresh(); setBusy(null)
  }
  function toggleRow(id: string) {
    setExpanded((prev) => (prev === id ? null : id))
    setSelected(new Set())
    setIpDraft({ keyId: null, ip: "", proxied: true })
    setSslDraft({ keyId: null, mode: "unchanged", alwaysHttps: "unchanged" })
  }
  function toggleDomain(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  // ---- Search filter — matches alias, email, account id, OR any assigned domain
  const filteredKeys = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return CF_KEYS
    return CF_KEYS.filter((k) => {
      if (k.label.toLowerCase().includes(q)) return true
      if (k.email.toLowerCase().includes(q)) return true
      if (k.accountId.toLowerCase().includes(q)) return true
      const doms = domainsByKey[Number(k.id)] ?? []
      return doms.some((d) => d.domain.toLowerCase().includes(q))
    })
  }, [CF_KEYS, domainsByKey, search])

  return (
    <AppShell
      title="Cloudflare"
      description={`${CF_KEYS.length} pooled API keys · click a row to manage assigned domains`}
      breadcrumbs={[{ label: "Cloudflare" }]}
      accent="cloudflare"
      actions={
        <>
          <Button
            variant="outline" size="sm"
            className="gap-1.5 hidden sm:inline-flex btn-soft-info"
            onClick={refreshAccounts} disabled={busy === "refresh"}
            title="Re-resolve cf_account_id from CF for every key"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", busy === "refresh" && "animate-spin")} /> Refresh Account IDs
          </Button>
          <Button
            variant="outline" size="sm"
            className="gap-1.5 hidden sm:inline-flex btn-soft-warning"
            onClick={syncFromCf} disabled={busy === "cfsync"}
            title="Walk every active CF key, list its zones, reconcile against the domains table — auto-backfills cf_zone_id when name matches CF, reports orphans + untracked zones for review"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", busy === "cfsync" && "animate-spin")} /> Sync from CF
          </Button>
          <Button
            variant="outline" size="sm"
            className="gap-1.5 hidden sm:inline-flex btn-soft-warning"
            onClick={openBulkAdd}
            title="Paste a CSV (or upload a file) of multiple CF keys at once. Header row needs email + api_key, optional alias."
          >
            <Upload className="h-3.5 w-3.5" /> Bulk add
          </Button>
          <Button size="sm" className="gap-1.5 btn-warning" onClick={openAdd}>
            <Plus className="h-3.5 w-3.5" /> Add CF Key
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

        {/* Flask-parity info banner */}
        <div className="rounded-md border border-status-running/30 bg-status-running/8 px-3 py-2 text-small text-status-running flex items-start gap-2">
          <Info className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
          <div>
            CF Global API keys are used to create per-domain DNS zones. The pool rotates across keys so
            no single CF account hits its 1000-zone limit. Each key holds up to{" "}
            <strong>max_domains</strong> zones (default 20); change per-key as needed via the row's edit action.
          </div>
        </div>

        {CF_KEYS.length === 0 ? (
          <div className="rounded-md border border-border bg-card flex flex-col items-center justify-center py-12 gap-3">
            <CloudOff className="h-8 w-8 text-muted-foreground" aria-hidden />
            <p className="text-small text-muted-foreground">No CF keys in pool yet</p>
            <Button size="sm" className="gap-1.5 btn-warning" onClick={openAdd}>
              <Plus className="h-3.5 w-3.5" /> Add your first CF key
            </Button>
          </div>
        ) : (
        <DataTableShell>
          <DataTableToolbar>
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search alias, email, account id or assigned domain…"
                className="h-8 pl-8 text-small"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-5 w-5 rounded text-muted-foreground hover:bg-muted hover:text-foreground inline-flex items-center justify-center"
                  aria-label="Clear search"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <div className="ml-auto text-micro text-muted-foreground">
              {filteredKeys.length === CF_KEYS.length
                ? `${CF_KEYS.length} keys`
                : `${filteredKeys.length} of ${CF_KEYS.length} keys`}{" "}
              · {CF_KEYS.reduce((acc, k) => acc + k.domains, 0)} domains assigned
            </div>
          </DataTableToolbar>

          {keysSelected.size > 0 && (
            <div className="sticky top-[56px] z-10 -mx-1 mb-2 flex flex-wrap items-center gap-3 rounded-md border border-status-terminal/40 bg-status-terminal/5 px-3 py-2 text-small">
              <span className="font-medium">
                {keysSelected.size} key{keysSelected.size === 1 ? "" : "s"} selected
              </span>
              <span className="mx-1 h-4 w-px bg-border" aria-hidden />
              <Button
                size="sm" variant="outline"
                className="gap-1.5 btn-soft-destructive"
                onClick={bulkDeleteKeys} disabled={busy === "bulk-del-keys"}
                title="Delete the selected CF keys (rows with referencing domains will be skipped)"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete selected
              </Button>
              <Button
                size="sm" variant="ghost" className="ml-auto"
                onClick={() => setKeysSelected(new Set())}
                title="Clear selection"
              >
                Clear
              </Button>
            </div>
          )}

          <DataTable>
            <DataTableHead>
              <DataTableRow>
                <DataTableHeaderCell className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all keys on this page"
                    checked={
                      filteredKeys.length > 0 &&
                      filteredKeys.every((k) => keysSelected.has(Number(k.id)))
                    }
                    ref={(el) => {
                      if (!el) return
                      const allOn = filteredKeys.length > 0 &&
                        filteredKeys.every((k) => keysSelected.has(Number(k.id)))
                      const someOn = filteredKeys.some((k) => keysSelected.has(Number(k.id)))
                      el.indeterminate = !allOn && someOn
                    }}
                    onChange={(e) => {
                      const next = new Set(keysSelected)
                      if (e.target.checked) {
                        for (const k of filteredKeys) next.add(Number(k.id))
                      } else {
                        for (const k of filteredKeys) next.delete(Number(k.id))
                      }
                      setKeysSelected(next)
                    }}
                  />
                </DataTableHeaderCell>
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
              {filteredKeys.map((k) => {
                const isOpen = expanded === k.id
                const realDomains = domainsByKey[Number(k.id)] ?? []
                const assigned = realDomains.map((d) => ({
                  id: d.domain,
                  name: d.domain,
                  ip: d.current_proxy_ip ?? "—",
                  status: d.status,
                }))
                return (
                  <React.Fragment key={k.id}>
                    <DataTableRow selected={isOpen}>
                      <DataTableCell>
                        <input
                          type="checkbox"
                          aria-label={`Select ${k.alias || k.email}`}
                          checked={keysSelected.has(Number(k.id))}
                          onChange={(e) => {
                            const next = new Set(keysSelected)
                            if (e.target.checked) next.add(Number(k.id))
                            else next.delete(Number(k.id))
                            setKeysSelected(next)
                          }}
                        />
                      </DataTableCell>
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
                          <code className="font-mono font-medium">{k.alias || "—"}</code>
                          {assigned.length > 0 && (
                            <button
                              onClick={() => toggleRow(k.id)}
                              className="text-micro text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                              title={`Show / hide the ${assigned.length} domains using this key`}
                            >
                              <ChevronRight className={cn("h-3 w-3 transition-transform", isOpen && "rotate-90")} />
                              {assigned.length} domain{assigned.length === 1 ? "" : "s"}
                            </button>
                          )}
                        </div>
                      </DataTableCell>
                      <DataTableCell>
                        <code className="font-mono text-micro text-muted-foreground">{k.email}</code>
                      </DataTableCell>
                      <DataTableCell>
                        <span
                          className="font-mono tabular-nums"
                          title={[
                            `${k.domains}/${k.maxDomains} pool slots used`,
                            k.keyPreview && `key ${k.keyPreview}`,
                            k.accountId && `account ${k.accountId}`,
                          ].filter(Boolean).join(" · ")}
                        >
                          {k.domains}
                        </span>
                      </DataTableCell>
                      <DataTableCell>
                        <div className="flex items-center gap-2 min-w-[120px]" title={`${k.domains}/${k.maxDomains} domains`}>
                          <span
                            className={cn(
                              "font-mono text-micro tabular-nums w-9 text-right",
                              k.rateLimitUsed >= 100
                                ? "text-status-terminal"
                                : k.rateLimitUsed >= 80
                                  ? "text-status-waiting"
                                  : "text-muted-foreground",
                            )}
                          >
                            {k.rateLimitUsed}%
                          </span>
                          <div className="relative h-1.5 flex-1 max-w-[80px] overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn(
                                "h-full rounded-full",
                                k.rateLimitUsed >= 100
                                  ? "bg-status-terminal"
                                  : k.rateLimitUsed >= 80
                                    ? "bg-status-waiting"
                                    : "bg-status-completed",
                              )}
                              style={{ width: `${k.rateLimitUsed}%` }}
                            />
                          </div>
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
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem onClick={() => openEditKey(Number(k.id), k.alias, k.maxDomains)}>
                              Edit alias / max
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => openZonesList(Number(k.id), k.label)}>
                              List zones in CF
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => runTestZone(Number(k.id), k.label)}>
                              Test create zone
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => openCsvModal(Number(k.id), k.label)}>
                              Bulk DNS upsert (CSV)
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => toggleKey(Number(k.id), k.isActive)}>
                              {k.isActive ? "Pause assignments" : "Activate"}
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={() => deleteKey(Number(k.id), k.label)}>
                              Remove from pool
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </DataTableCell>
                    </DataTableRow>

                    {isOpen && (
                      <tr>
                        <td colSpan={9} className="bg-muted/30 p-0 border-b border-border">
                          <div className="px-4 py-3">
                            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <h3 className="text-[13px] font-semibold">Domains on {k.label}</h3>
                                <span className="rounded bg-card px-1.5 py-0.5 text-micro font-medium tabular-nums text-muted-foreground border border-border">
                                  {assigned.length} of {k.domains}
                                </span>
                              </div>
                              <ButtonGroup>
                                <Button
                                  variant="outline" size="sm" className="gap-1.5"
                                  onClick={() => {
                                    setIpDraft({ keyId: Number(k.id), ip: "", proxied: true })
                                    setSslDraft({ keyId: null, mode: "unchanged", alwaysHttps: "unchanged" })
                                  }}
                                >
                                  <Zap className="h-3.5 w-3.5" /> Change A-records
                                </Button>
                                <Button
                                  variant="outline" size="sm" className="gap-1.5"
                                  onClick={() => {
                                    setSslDraft({ keyId: Number(k.id), mode: "unchanged", alwaysHttps: "unchanged" })
                                    setIpDraft({ keyId: null, ip: "", proxied: true })
                                  }}
                                >
                                  <ShieldCheck className="h-3.5 w-3.5" /> SSL / Always-HTTPS
                                </Button>
                                <Button
                                  variant="outline" size="sm" className="gap-1.5"
                                  onClick={() => openCsvModal(Number(k.id), k.label)}
                                >
                                  <Upload className="h-3.5 w-3.5" /> Bulk DNS CSV
                                </Button>
                                <Button
                                  variant="outline" size="sm" className="gap-1.5 btn-soft-info"
                                  onClick={() => loadZoneSettings(Number(k.id))}
                                  disabled={zoneLoading[Number(k.id)]}
                                  title="Fetch live SSL mode + Always-HTTPS from Cloudflare for every domain on this key (one-shot, on demand)"
                                >
                                  <RefreshCw className={cn("h-3.5 w-3.5", zoneLoading[Number(k.id)] && "animate-spin")} />
                                  Load CF settings
                                </Button>
                                <Button
                                  variant="outline" size="sm" className="gap-1.5 btn-soft-success"
                                  onClick={() => refreshStatus(Number(k.id))}
                                  disabled={statusRefreshing[Number(k.id)]}
                                  title="HTTPS-probe every hosted/live domain under this key and flip status to 'live' (or back to 'hosted' on failure). Use when the background live-checker is OFF and rows show 'hosted' even though the sites respond 200."
                                >
                                  <RefreshCw className={cn("h-3.5 w-3.5", statusRefreshing[Number(k.id)] && "animate-spin")} />
                                  Refresh status
                                </Button>
                              </ButtonGroup>

                            {ipDraft.keyId === Number(k.id) && (
                              <form
                                onSubmit={(e) => { e.preventDefault(); submitBulkIp(Number(k.id), [...selected]) }}
                                className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-border/70 bg-card p-3"
                              >
                                <Field className="flex-1 min-w-[180px]">
                                  <FieldLabel>New A-record IP (apex + www)</FieldLabel>
                                  <Input
                                    value={ipDraft.ip}
                                    onChange={(e) => setIpDraft((d) => ({ ...d, ip: e.target.value }))}
                                    placeholder="1.2.3.4"
                                    autoFocus
                                  />
                                </Field>
                                <label className="inline-flex items-center gap-2 text-small">
                                  <Checkbox
                                    checked={ipDraft.proxied}
                                    onCheckedChange={(v) => setIpDraft((d) => ({ ...d, proxied: Boolean(v) }))}
                                  />
                                  Proxied (orange cloud)
                                </label>
                                <div className="ml-auto flex items-center gap-2">
                                  <span className="text-micro text-muted-foreground">
                                    {selected.size} domain(s) selected
                                  </span>
                                  <Button type="button" variant="ghost" size="sm"
                                    onClick={() => setIpDraft({ keyId: null, ip: "", proxied: true })}>
                                    Cancel
                                  </Button>
                                  <Button type="submit" size="sm"
                                    disabled={selected.size === 0 || busy === `bip-${k.id}`}>
                                    Apply to selected
                                  </Button>
                                </div>
                              </form>
                            )}

                            {sslDraft.keyId === Number(k.id) && (
                              <form
                                onSubmit={(e) => { e.preventDefault(); submitBulkSsl(Number(k.id), [...selected]) }}
                                className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-border/70 bg-card p-3"
                              >
                                <Field className="min-w-[160px]">
                                  <FieldLabel>SSL mode</FieldLabel>
                                  <Select value={sslDraft.mode} onValueChange={(v) => setSslDraft((d) => ({ ...d, mode: v }))}>
                                    <SelectTrigger size="sm" className="h-8 text-small"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="unchanged">SSL: unchanged</SelectItem>
                                      <SelectItem value="off">SSL: Off</SelectItem>
                                      <SelectItem value="flexible">SSL: Flexible</SelectItem>
                                      <SelectItem value="full">SSL: Full</SelectItem>
                                      <SelectItem value="strict">SSL: Full (strict)</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </Field>
                                <Field className="min-w-[180px]">
                                  <FieldLabel>Always-HTTPS</FieldLabel>
                                  <Select value={sslDraft.alwaysHttps} onValueChange={(v) => setSslDraft((d) => ({ ...d, alwaysHttps: v }))}>
                                    <SelectTrigger size="sm" className="h-8 text-small"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="unchanged">Always-HTTPS: unchanged</SelectItem>
                                      <SelectItem value="on">Always-HTTPS: On</SelectItem>
                                      <SelectItem value="off">Always-HTTPS: Off</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </Field>
                                <div className="ml-auto flex items-center gap-2">
                                  <span className="text-micro text-muted-foreground">
                                    {selected.size} domain(s) selected
                                  </span>
                                  <Button type="button" variant="ghost" size="sm"
                                    onClick={() => setSslDraft({ keyId: null, mode: "unchanged", alwaysHttps: "unchanged" })}>
                                    Cancel
                                  </Button>
                                  <Button type="submit" size="sm"
                                    disabled={selected.size === 0 || busy === `bssl-${k.id}`}>
                                    Apply to selected
                                  </Button>
                                </div>
                              </form>
                            )}
                            </div>

                            {assigned.length === 0 ? (
                              <div className="text-small text-muted-foreground rounded-md border border-border bg-card px-3 py-4 text-center">
                                No domains assigned to this key yet.
                              </div>
                            ) : (
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
                                    <th className="px-3 py-1.5 text-left text-micro font-medium uppercase tracking-wider text-muted-foreground">Domain</th>
                                    <th className="px-3 py-1.5 text-left text-micro font-medium uppercase tracking-wider text-muted-foreground">A-record</th>
                                    <th className="px-3 py-1.5 text-left text-micro font-medium uppercase tracking-wider text-muted-foreground">SSL mode</th>
                                    <th className="px-3 py-1.5 text-left text-micro font-medium uppercase tracking-wider text-muted-foreground">Always HTTPS</th>
                                    <th className="px-3 py-1.5 text-left text-micro font-medium uppercase tracking-wider text-muted-foreground">Status</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {assigned.map((d) => {
                                    const zs = zoneSettings[Number(k.id)]?.[d.name]
                                    return (
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
                                        <td className="px-3 py-2">
                                          {zs?.error ? (
                                            <span className="text-status-terminal text-micro" title={zs.error}>error</span>
                                          ) : zs?.ssl_mode ? (
                                            <code className="font-mono text-micro text-foreground/85">{zs.ssl_mode}</code>
                                          ) : (
                                            <span className="text-muted-foreground" title="Click 'Load CF settings' to fetch live SSL mode from Cloudflare">—</span>
                                          )}
                                        </td>
                                        <td className="px-3 py-2">
                                          {zs?.error ? (
                                            <span className="text-muted-foreground">—</span>
                                          ) : zs?.always_https ? (
                                            <StatusBadge
                                              status={zs.always_https === "on" ? "completed" : "canceled"}
                                              label={zs.always_https === "on" ? "On" : "Off"}
                                            />
                                          ) : (
                                            <span className="text-muted-foreground" title="Click 'Load CF settings' to fetch live Always-HTTPS state from Cloudflare">—</span>
                                          )}
                                        </td>
                                        <td className="px-3 py-2">
                                          <StatusBadge status={d.status as never} label={d.status} />
                                        </td>
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                            )}

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
                                  <Button
                                    size="sm" variant="outline"
                                    onClick={() => {
                                      setIpDraft({ keyId: Number(k.id), ip: "", proxied: true })
                                      setSslDraft({ keyId: null, mode: "unchanged", alwaysHttps: "unchanged" })
                                    }}
                                  >
                                    Change A-records
                                  </Button>
                                  <Button
                                    size="sm" variant="outline"
                                    onClick={() => {
                                      setSslDraft({ keyId: Number(k.id), mode: "unchanged", alwaysHttps: "unchanged" })
                                      setIpDraft({ keyId: null, ip: "", proxied: true })
                                    }}
                                  >
                                    SSL / Always-HTTPS
                                  </Button>
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
              {filteredKeys.length === 0 && CF_KEYS.length > 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-small text-muted-foreground">
                    No keys match {JSON.stringify(search)}.
                  </td>
                </tr>
              )}
            </tbody>
          </DataTable>
        </DataTableShell>
        )}
      </div>

      {/* ---------- Add CF key dialog ---------- */}
      <OperatorDialog
        open={addOpen}
        onOpenChange={(o) => { if (!o) setAddOpen(false) }}
        title="Add Cloudflare API Key"
        description="Live-verifies via /accounts before insert. The full key never leaves the DB after this — only a 6+4 preview is shown in the table."
        submitLabel="Verify & Add to Pool"
        onSubmit={submitAdd}
        resultMessage={addResult?.text ?? null}
        resultKind={addResult?.kind ?? null}
      >
        <Field>
          <FieldLabel>Cloudflare account email</FieldLabel>
          <Input
            type="email" value={addEmail}
            onChange={(e) => setAddEmail(e.target.value)}
            placeholder="ops@example.com"
            autoFocus
          />
        </Field>
        <Field>
          <FieldLabel>Global API Key</FieldLabel>
          <div className="relative">
            <Input
              type={showApiKey ? "text" : "password"}
              value={addApiKey}
              onChange={(e) => setAddApiKey(e.target.value)}
              className="pr-9 font-mono"
              placeholder="40-char key"
            />
            <button
              type="button"
              onClick={() => setShowApiKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={showApiKey ? "Hide API key" : "Show API key"}
              tabIndex={-1}
            >
              {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
          <FieldDescription>
            Found at dash.cloudflare.com → Profile → API Tokens → Global API Key.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel>
            Alias <span className="text-muted-foreground font-normal">(optional)</span>
          </FieldLabel>
          <Input
            value={addAlias}
            onChange={(e) => setAddAlias(e.target.value)}
            placeholder="e.g. CF-mainacct"
          />
          <FieldDescription>For your own labeling — shown in the Alias column.</FieldDescription>
        </Field>
      </OperatorDialog>

      {/* ---------- Bulk add CF keys (CSV paste / file upload) ---------- */}
      <OperatorDialog
        open={bulkAddOpen}
        onOpenChange={(o) => { if (!o) setBulkAddOpen(false) }}
        title="Bulk add CF keys"
        description="Paste a CSV or upload a file. Header row needs columns: email, api_key, alias (alias is optional; `name` accepted as alias). Each row is verified against CF /accounts before insert — bad rows fail individually without aborting the batch."
        submitLabel={bulkAddResult ? "Done" : "Add all"}
        onSubmit={bulkAddResult ? () => setBulkAddOpen(false) : submitBulkAdd}
      >
        {!bulkAddResult ? (
          <>
            <Field>
              <FieldLabel>CSV file</FieldLabel>
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={(e) => setBulkAddFile(e.target.files?.[0] ?? null)}
                className="text-small"
              />
              <FieldDescription>
                Or paste below — file takes precedence if both are provided.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Or paste CSV text</FieldLabel>
              <textarea
                value={bulkAddText}
                onChange={(e) => setBulkAddText(e.target.value)}
                rows={10}
                placeholder={"email,api_key,alias\ncf1@example.com,abcdef0123…,CF1\ncf2@example.com,fedcba9876…,CF2"}
                className="w-full rounded-md border border-border/60 bg-background p-2 font-mono text-small"
              />
              <FieldDescription>
                Header row is required. Empty lines and blank rows are skipped automatically.
              </FieldDescription>
            </Field>
          </>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2 text-small">
              <span className="text-status-completed font-semibold">✓ {bulkAddResult.added} added</span>
              {bulkAddResult.errored > 0 && (
                <span className="text-status-terminal font-semibold">✗ {bulkAddResult.errored} errored</span>
              )}
            </div>
            <div className="max-h-[40vh] overflow-y-auto rounded-md border border-border/60">
              <table className="w-full text-small">
                <thead className="border-b border-border/60 bg-muted/40">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">Email</th>
                    <th className="px-2 py-1 text-left font-medium">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {bulkAddResult.results.map((r, i) => (
                    <tr key={i} className="border-b border-border/30 last:border-0">
                      <td className="px-2 py-1 font-mono text-micro">{r.email}</td>
                      <td className="px-2 py-1 text-micro">
                        {r.ok
                          ? <span className="text-status-completed">added</span>
                          : <span className="text-status-terminal" title={r.error}>{r.error ?? "failed"}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </OperatorDialog>

      {/* ---------- Edit CF key dialog ---------- */}
      <OperatorDialog
        open={editingKey !== null}
        onOpenChange={(o) => { if (!o) setEditingKey(null) }}
        title={`Edit CF key #${editingKey?.id ?? ""}`}
        description="Email + API key are intentionally read-only — re-add a fresh key for those."
        submitLabel="Save"
        onSubmit={submitEditKey}
        resultMessage={editKeyResult?.text ?? null}
        resultKind={editKeyResult?.kind ?? null}
      >
        <Field>
          <FieldLabel>Alias</FieldLabel>
          <Input
            value={editingKey?.alias ?? ""}
            onChange={(e) => setEditingKey((s) => s ? { ...s, alias: e.target.value } : s)}
            placeholder="optional friendly name"
          />
        </Field>
        <Field>
          <FieldLabel>Max domains</FieldLabel>
          <Input
            type="number" value={editingKey?.max ?? ""}
            onChange={(e) => setEditingKey((s) => s ? { ...s, max: e.target.value } : s)}
            placeholder="20"
          />
          <FieldDescription>
            CF accounts allow ~1000 zones; we cap per-key to spread load. 1–1000.
          </FieldDescription>
        </Field>
      </OperatorDialog>

      {/* ---------- Bulk DNS CSV dialog ---------- */}
      <OperatorDialog
        open={csvKey !== null}
        onOpenChange={(o) => { if (!o) setCsvKey(null) }}
        title={`Bulk DNS upsert${csvKey ? ` — ${csvKey.label}` : ""}`}
        description={
          "Idempotent upsert: each row finds the existing record by (domain, type, name) and updates it; creates if missing. " +
          "Required columns: domain, type, name, content. Optional: proxied (true/false), ttl (1=auto). " +
          "Types: A, AAAA, CNAME, TXT. Cap: 256 KiB body, 5000 rows. " +
          "Domain rows must already be assigned to this CF key."
        }
        submitLabel="Apply"
        onSubmit={submitCsv}
        resultMessage={csvResult?.text ?? null}
        resultKind={csvResult?.kind ?? null}
      >
        <Field>
          <FieldLabel>Paste CSV</FieldLabel>
          <Textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            rows={9}
            className="font-mono text-small"
            placeholder={
              "domain,type,name,content,proxied,ttl\n" +
              "example.com,A,@,1.2.3.4,true,1\n" +
              "example.com,A,www,1.2.3.4,true,1\n" +
              "example.com,CNAME,blog,medium.com,false,300\n" +
              "example.com,TXT,_dmarc,v=DMARC1; p=none,,3600"
            }
          />
        </Field>
        <Field>
          <FieldLabel>…or upload a .csv file</FieldLabel>
          <label className="flex items-center gap-2 cursor-pointer rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 hover:bg-muted/50 text-small">
            <FileUp className="h-4 w-4 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">
              {csvFile ? csvFile.name : "Click to choose a .csv file"}
            </span>
            <input
              type="file" accept=".csv,text/csv" className="hidden"
              onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)}
            />
            {csvFile && (
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); setCsvFile(null) }}
                className="ml-auto text-micro text-muted-foreground hover:text-foreground"
              >
                clear
              </button>
            )}
          </label>
          <FieldDescription>If both paste + file are given, the paste wins.</FieldDescription>
        </Field>
      </OperatorDialog>

      {/* === Test create zone diagnostic === */}
      <OperatorDialog
        open={testZone !== null}
        onOpenChange={(o) => { if (!o) setTestZone(null) }}
        title={`Test create zone — ${testZone?.label ?? ""}`}
        description="Creates a throwaway .example zone with this key, captures CF's response, then immediately deletes it. Confirms (email, api_key, account_id) can mint zones."
        submitLabel="Close"
        onSubmit={() => setTestZone(null)}
      >
        {testZone?.running ? (
          <div className="text-small text-muted-foreground">Calling Cloudflare…</div>
        ) : testZone?.result ? (
          <div className="flex flex-col gap-2 text-small">
            {testZone.result.ok ? (
              <>
                <div className="rounded-md border border-status-completed/30 bg-status-completed/8 px-3 py-2 text-status-completed">
                  ✓ Cloudflare accepted zone create — see details below.
                </div>
                <dl className="font-mono text-xs flex flex-col gap-1">
                  <div><span className="text-muted-foreground">test_zone_name:</span> {testZone.result.test_zone_name}</div>
                  <div><span className="text-muted-foreground">zone_id:</span> {testZone.result.zone_id}</div>
                  <div><span className="text-muted-foreground">initial_status:</span> {testZone.result.initial_status}</div>
                  <div className="break-all"><span className="text-muted-foreground">nameservers:</span> {testZone.result.nameservers?.join(", ")}</div>
                  <div>
                    <span className="text-muted-foreground">cleanup:</span>{" "}
                    {testZone.result.cleanup?.deleted ? (
                      <span className="text-status-completed">deleted ✓</span>
                    ) : (
                      <span className="text-status-terminal">
                        FAILED — orphan zone_id={testZone.result.cleanup?.orphan_zone_id} ({testZone.result.cleanup?.error})
                      </span>
                    )}
                  </div>
                </dl>
              </>
            ) : (
              <div className="rounded-md border border-status-terminal/30 bg-status-terminal/8 px-3 py-2 text-status-terminal">
                ✗ {testZone.result.error ?? "Test zone create failed"}
                {testZone.result.stage && ` (stage: ${testZone.result.stage})`}
              </div>
            )}
          </div>
        ) : null}
      </OperatorDialog>

      {/* === Zones-in-CF live list === */}
      <OperatorDialog
        open={zonesListKey !== null}
        onOpenChange={(o) => { if (!o) { setZonesListKey(null); setZonesListData(null) } }}
        title={`Zones in CF account — ${zonesListKey?.label ?? ""}`}
        description="Live read from Cloudflare's /zones endpoint, joined against SSR's domain rows. Surfaces orphans (in CF but not SSR) and missing zones (SSR thinks it created but CF doesn't have)."
        submitLabel="Close"
        onSubmit={() => { setZonesListKey(null); setZonesListData(null) }}
      >
        {zonesListLoading ? (
          <div className="text-small text-muted-foreground">Loading from Cloudflare…</div>
        ) : zonesListData?.ok ? (
          <div className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
            <div className="text-micro text-muted-foreground font-mono">
              account_id={zonesListData.cf_account_id} · {zonesListData.total_in_cf} zone(s) in CF · {zonesListData.total_tracked} tracked by SSR
            </div>
            {zonesListData.zones?.length === 0 && (
              <div className="text-small text-muted-foreground">No zones in this CF account.</div>
            )}
            <div className="flex flex-col gap-1">
              {zonesListData.zones?.map((z) => (
                <div key={z.cf_zone_id}
                  className="rounded-md border border-border/60 bg-card px-2.5 py-2 flex items-center justify-between gap-2 text-small">
                  <div className="flex flex-col min-w-0">
                    <span className="font-medium truncate">{z.name}</span>
                    <span className="font-mono text-[11px] text-muted-foreground truncate">
                      {z.cf_zone_id}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 text-[11px]">
                    <span className={cn(
                      "rounded-sm px-1.5 py-0.5 font-medium",
                      z.cf_status === "active" && "bg-status-completed/15 text-status-completed",
                      z.cf_status === "pending" && "bg-status-waiting/15 text-status-waiting",
                      z.cf_status !== "active" && z.cf_status !== "pending" && "bg-muted text-muted-foreground",
                    )}>cf:{z.cf_status}</span>
                    {z.tracked ? (
                      <span className="rounded-sm bg-status-running/15 text-status-running px-1.5 py-0.5 font-medium">
                        tracked
                      </span>
                    ) : (
                      <span className="rounded-sm bg-status-terminal/10 text-status-terminal px-1.5 py-0.5 font-medium">
                        orphan
                      </span>
                    )}
                    {z.ssr_zone_id_match === false && (
                      <span className="rounded-sm bg-status-terminal/15 text-status-terminal px-1.5 py-0.5 font-medium"
                        title="SSR's cf_zone_id for this domain doesn't match CF's">
                        zone-id mismatch
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {(zonesListData.tracked_missing_in_cf?.length ?? 0) > 0 && (
              <div className="mt-2">
                <div className="text-small font-medium text-status-terminal mb-1">
                  SSR domains whose zone CF doesn't have ({zonesListData.tracked_missing_in_cf?.length})
                </div>
                <div className="flex flex-col gap-1">
                  {zonesListData.tracked_missing_in_cf?.map((m) => (
                    <div key={m.domain}
                      className="rounded-md border border-status-terminal/30 bg-status-terminal/5 px-2.5 py-1.5 text-small">
                      <span className="font-medium">{m.domain}</span>
                      <span className="font-mono text-[11px] text-muted-foreground ml-2">
                        zone_id={m.cf_zone_id ?? "—"} · ssr_status={m.ssr_status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : zonesListData ? (
          <div className="rounded-md border border-status-terminal/30 bg-status-terminal/8 px-3 py-2 text-small text-status-terminal">
            ✗ {zonesListData.error ?? "Failed to load zones from Cloudflare"}
          </div>
        ) : null}
      </OperatorDialog>
    </AppShell>
  )
}
