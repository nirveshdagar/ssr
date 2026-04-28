"use client"

import * as React from "react"
import {
  RefreshCw, ChevronDown, ChevronRight, ExternalLink, FileCode2, Server as ServerIcon,
  Zap, Save, RotateCcw, Eye, Check, X, AlertTriangle, Activity, Cpu, MemoryStick, HardDrive,
  Boxes, ShieldCheck, ArrowUp, ArrowDown, Replace, Pencil, Scissors, Upload, FileUp,
} from "lucide-react"
import useSWR from "swr"
import { AppShell } from "@/components/ssr/app-shell"
import { StatusBadge } from "@/components/ssr/status-badge"
import { OperatorDialog } from "@/components/ssr/operator-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldLabel, FieldDescription, FieldGroup } from "@/components/ui/field"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Types — match lib/sa-control return shapes
// ---------------------------------------------------------------------------

interface FleetApp {
  sa_app_id: string
  name: string
  domain: string
  php_version: string | null
  ssl_status: string | null
  last_heartbeat_at: string | null
  ssr_status: string | null
}

interface FleetServer {
  sa_server_id: string
  sa_name: string
  sa_status: string
  ip: string
  cpu_usage: number | null
  ram_usage: number | null
  disk_usage: number | null
  uptime: string | null
  os: string | null
  db_server_id: number | null
  db_status: string | null
  apps: FleetApp[]
}

interface FleetResponse {
  ok: boolean
  servers?: FleetServer[]
  error?: string
}

const fetcher = (url: string) => fetch(url, { credentials: "same-origin" }).then((r) => r.json())

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ServerAvatarPage() {
  const { data, isLoading, mutate } = useSWR<FleetResponse>("/api/sa/fleet", fetcher, {
    refreshInterval: 30_000,
  })
  const servers = data?.servers ?? []

  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // --- App drawer state -----------------------------------------------------
  const [drawerApp, setDrawerApp] = React.useState<{ app: FleetApp; server: FleetServer } | null>(null)

  // --- Upload dialog state — shared single + bulk -------------------------
  const [uploadCtx, setUploadCtx] = React.useState<
    | { mode: "single"; domain: string; server_ip: string }
    | { mode: "bulk"; targets: { domain: string; server_ip: string }[] }
    | null
  >(null)

  // --- Bulk selection state -------------------------------------------------
  const [selectedApps, setSelectedApps] = React.useState<Set<string>>(new Set())
  const selectedTargets: { domain: string; server_ip: string }[] = React.useMemo(() => {
    const out: { domain: string; server_ip: string }[] = []
    for (const s of servers) {
      for (const a of s.apps) {
        if (selectedApps.has(a.sa_app_id) && a.domain && s.ip) {
          out.push({ domain: a.domain, server_ip: s.ip })
        }
      }
    }
    return out
  }, [servers, selectedApps])
  const [bulkOpen, setBulkOpen] = React.useState(false)

  // --- Toast / flash --------------------------------------------------------
  const [flash, setFlash] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)
  function show(kind: "ok" | "err", text: string) {
    setFlash({ kind, text })
    window.setTimeout(() => setFlash(null), 5500)
  }

  // --- Service restart ------------------------------------------------------
  const [busyServer, setBusyServer] = React.useState<string | null>(null)
  async function restartServices(serverIp: string, service: "web" | "php-fpm" | "both") {
    if (!confirm(`Restart ${service} on ${serverIp}?\n\nThis briefly drops requests in-flight on that server.`)) return
    setBusyServer(serverIp)
    const fd = new FormData()
    fd.set("server_ip", serverIp)
    fd.set("service", service)
    const r = await fetch("/api/sa/service-restart", { method: "POST", body: fd, credentials: "same-origin" })
    const j = await r.json()
    show(j.ok ? "ok" : "err", j.message ?? j.error ?? "")
    setBusyServer(null)
  }

  // ----- Totals -------------------------------------------------------------
  const totalApps = servers.reduce((acc, s) => acc + s.apps.length, 0)
  const onlineCount = servers.filter((s) => /connected|active|1/i.test(s.sa_status)).length

  return (
    <AppShell
      title="ServerAvatar"
      description={`${servers.length} server(s) · ${totalApps} apps · ${onlineCount} agent online`}
      breadcrumbs={[{ label: "ServerAvatar" }]}
      accent="sa"
      actions={
        <Button
          variant="outline" size="sm" className="gap-1.5"
          onClick={() => mutate()} disabled={isLoading}
          title="Re-fetch fleet from SA"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} /> Refresh
        </Button>
      }
    >
      {flash && (
        <div className={cn(
          "mb-4 rounded-md border px-3 py-2 text-small",
          flash.kind === "ok"
            ? "border-status-completed/30 bg-status-completed/8 text-status-completed"
            : "border-status-terminal/30 bg-status-terminal/8 text-status-terminal",
        )}>{flash.text}</div>
      )}

      {/* Bulk action bar — only when apps selected */}
      {selectedTargets.length > 0 && (
        <div className="sticky top-2 z-20 mb-4 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-sm">
          <span className="text-small font-medium">{selectedTargets.length} app(s) selected</span>
          <span className="mx-1 h-4 w-px bg-border" />
          <Button
            size="sm" variant="outline" className="gap-1.5 btn-soft-info"
            onClick={() => setBulkOpen(true)}
            title="Run a bulk index.php edit across selected apps — backup created on each before write"
          >
            <FileCode2 className="h-3.5 w-3.5" /> Bulk edit index.php
          </Button>
          <Button
            size="sm" variant="outline" className="gap-1.5 btn-soft-info"
            onClick={() => setUploadCtx({ mode: "bulk", targets: selectedTargets })}
            title="Upload an arbitrary file (any extension) to /public_html/ on every selected app"
          >
            <FileUp className="h-3.5 w-3.5" /> Bulk upload file
          </Button>
          <Button
            size="sm" variant="ghost" className="ml-auto"
            onClick={() => setSelectedApps(new Set())}
          >Clear</Button>
        </div>
      )}

      {/* Server list */}
      <div className="flex flex-col gap-3">
        {isLoading && servers.length === 0 && (
          <div className="rounded-md border border-border bg-card px-4 py-8 text-center text-muted-foreground">
            Loading SA fleet…
          </div>
        )}
        {!isLoading && servers.length === 0 && (
          <div className="rounded-md border border-border bg-card px-4 py-8 text-center text-muted-foreground">
            No servers reported by ServerAvatar. Check API key / org id in /settings.
          </div>
        )}
        {servers.map((s) => {
          const isOpen = expanded.has(s.sa_server_id)
          const cpuPct = s.cpu_usage != null ? Math.min(100, Math.round(s.cpu_usage)) : null
          const ramPct = s.ram_usage != null ? Math.min(100, Math.round(s.ram_usage)) : null
          const diskPct = s.disk_usage != null ? Math.min(100, Math.round(s.disk_usage)) : null
          return (
            <section
              key={s.sa_server_id}
              className="rounded-lg border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
            >
              <header className="flex flex-wrap items-center gap-3 px-4 py-3">
                <button
                  onClick={() => toggle(s.sa_server_id)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={isOpen ? "Collapse" : "Expand"}
                >
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
                <ServerIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
                <div className="flex flex-col min-w-0">
                  <span className="font-medium truncate">{s.sa_name}</span>
                  <span className="font-mono text-micro text-muted-foreground">{s.ip} · sa_id={s.sa_server_id}</span>
                </div>
                <span className="ml-2">
                  <StatusBadge status={
                    /connected|active|1/i.test(s.sa_status) ? "live" : "terminal_error"
                  } />
                </span>
                <div className="ml-auto flex items-center gap-3 text-micro">
                  <Stat icon={Cpu} label="CPU" value={cpuPct} />
                  <Stat icon={MemoryStick} label="RAM" value={ramPct} />
                  <Stat icon={HardDrive} label="Disk" value={diskPct} />
                  <span className="font-mono text-muted-foreground">{s.apps.length} apps</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm" variant="ghost" className="h-7 w-7 p-0"
                    onClick={() => mutate()}
                    disabled={isLoading}
                    title="Sync server stats — refetches the fleet from SA"
                  >
                    <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
                  </Button>
                  <Button
                    size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs"
                    onClick={() => restartServices(s.ip, "both")}
                    disabled={busyServer === s.ip || !s.ip}
                    title="SSH: reload web server + restart php-fpm"
                  >
                    <Zap className="h-3 w-3" /> Restart services
                  </Button>
                  <a
                    href={`https://app.serveravatar.com/organizations/$ORG/servers/${s.sa_server_id}`}
                    target="_blank" rel="noopener noreferrer"
                    title="Open in ServerAvatar dashboard (replace $ORG with your org id manually if your token has multi-org access)"
                  >
                    <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs">
                      <ExternalLink className="h-3 w-3" /> Open
                    </Button>
                  </a>
                </div>
              </header>

              {isOpen && (
                <div className="border-t border-border px-4 py-3">
                  {s.apps.length === 0 ? (
                    <div className="text-small text-muted-foreground">No apps on this server.</div>
                  ) : (
                    <table className="w-full text-small">
                      <thead className="text-micro text-muted-foreground">
                        <tr className="border-b border-border">
                          <th className="px-2 py-1.5 text-left w-8" />
                          <th className="px-2 py-1.5 text-left">Domain</th>
                          <th className="px-2 py-1.5 text-left">PHP</th>
                          <th className="px-2 py-1.5 text-left">SSL</th>
                          <th className="px-2 py-1.5 text-left">SSR status</th>
                          <th className="px-2 py-1.5 text-left">Last heartbeat</th>
                          <th className="px-2 py-1.5 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.apps.map((a) => {
                          const isSelected = selectedApps.has(a.sa_app_id)
                          return (
                            <tr key={a.sa_app_id} className="border-b border-border/50 last:border-b-0">
                              <td className="px-2 py-1.5">
                                <Checkbox
                                  checked={isSelected}
                                  onCheckedChange={(v) => {
                                    setSelectedApps((prev) => {
                                      const next = new Set(prev)
                                      if (v) next.add(a.sa_app_id)
                                      else next.delete(a.sa_app_id)
                                      return next
                                    })
                                  }}
                                  aria-label={`Select ${a.domain}`}
                                />
                              </td>
                              <td className="px-2 py-1.5 font-mono text-xs">{a.domain || a.name}</td>
                              <td className="px-2 py-1.5 text-muted-foreground">{a.php_version ?? "—"}</td>
                              <td className="px-2 py-1.5">
                                <code className="font-mono text-micro text-muted-foreground">{a.ssl_status ?? "—"}</code>
                              </td>
                              <td className="px-2 py-1.5">
                                {a.ssr_status
                                  ? <code className={cn(
                                      "font-mono text-micro",
                                      (a.ssr_status === "live" || a.ssr_status === "hosted") && "text-status-completed",
                                    )}>{a.ssr_status}</code>
                                  : <span className="text-muted-foreground">—</span>}
                              </td>
                              <td className={cn(
                                "px-2 py-1.5 font-mono text-micro",
                                // Pipeline at success → no worker beats are
                                // expected; render quietly so a stale beat
                                // here doesn't read as a problem.
                                (a.ssr_status === "live" || a.ssr_status === "hosted")
                                  ? "text-muted-foreground/50"
                                  : "text-muted-foreground",
                              )}>
                                {a.last_heartbeat_at ?? "—"}
                              </td>
                              <td className="px-2 py-1.5">
                                <div className="flex justify-end gap-1">
                                  <Button
                                    size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs"
                                    onClick={() => setDrawerApp({ app: a, server: s })}
                                    title="Open app control panel — edit index.php, restart, SSL"
                                    disabled={!a.domain || !s.ip}
                                  >
                                    <FileCode2 className="h-3 w-3" /> Manage
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>

      {/* "Coming when SA exposes API" — non-shipped sections */}
      <section className="mt-6 rounded-md border border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2 text-small font-medium">
          <Boxes className="h-3.5 w-3.5 text-muted-foreground" /> Coming when ServerAvatar exposes API
        </div>
        <p className="mt-1 text-micro text-muted-foreground">
          Database management · Firewall management · Backups · Cron jobs · Git deployments · Full file browser ·
          Historical monitoring graphs. These are operationally high-risk to glue via SSH alone — we'll add them
          here as soon as SA publishes proper REST endpoints.
        </p>
      </section>

      {drawerApp && (
        <AppDrawer
          app={drawerApp.app}
          server={drawerApp.server}
          onClose={() => setDrawerApp(null)}
          onFlash={show}
          onUpload={() => {
            if (drawerApp.app.domain && drawerApp.server.ip) {
              setUploadCtx({
                mode: "single",
                domain: drawerApp.app.domain,
                server_ip: drawerApp.server.ip,
              })
            }
          }}
        />
      )}

      {uploadCtx && (
        <UploadFileDialog
          ctx={uploadCtx}
          onClose={() => setUploadCtx(null)}
          onDone={(msg, ok) => { setUploadCtx(null); show(ok ? "ok" : "err", msg) }}
        />
      )}

      {bulkOpen && (
        <BulkEditDialog
          targets={selectedTargets}
          onClose={() => setBulkOpen(false)}
          onDone={(result) => {
            setBulkOpen(false)
            setSelectedApps(new Set())
            show(
              result.failed === 0 ? "ok" : "err",
              `Bulk edit: ${result.succeeded} ok · ${result.failed} failed · ${result.unchanged} unchanged`,
            )
          }}
        />
      )}
    </AppShell>
  )
}

// ---------------------------------------------------------------------------
// Stat pill — small CPU/RAM/disk indicator with bar
// ---------------------------------------------------------------------------

function Stat({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: number | null }) {
  const pct = value ?? 0
  const tone =
    value == null ? "text-muted-foreground" :
    pct >= 90 ? "text-status-terminal" :
    pct >= 70 ? "text-status-waiting" :
    "text-foreground/80"
  return (
    <span className="inline-flex items-center gap-1" title={`${label}: ${value == null ? "—" : pct + "%"}`}>
      <Icon className={cn("h-3 w-3", tone)} />
      <span className={cn("font-mono tabular-nums", tone)}>{value == null ? "—" : `${pct}%`}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// App drawer — single-app control panel
// ---------------------------------------------------------------------------

function AppDrawer({
  app, server, onClose, onFlash, onUpload,
}: {
  app: FleetApp
  server: FleetServer
  onClose: () => void
  onFlash: (k: "ok" | "err", t: string) => void
  onUpload: () => void
}) {
  const [content, setContent] = React.useState<string>("")
  const [originalContent, setOriginalContent] = React.useState<string>("")
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [hasBackup, setHasBackup] = React.useState(false)
  const [showDiff, setShowDiff] = React.useState(false)
  const [readErr, setReadErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setReadErr(null)
      const url = `/api/sa/index-file?domain=${encodeURIComponent(app.domain)}&server_ip=${encodeURIComponent(server.ip)}`
      try {
        const r = await fetch(url, { credentials: "same-origin" })
        const j = await r.json()
        if (cancelled) return
        if (!j.ok) {
          setReadErr(j.error ?? "read failed")
          setContent(""); setOriginalContent("")
        } else {
          setContent(j.content ?? "")
          setOriginalContent(j.content ?? "")
          setHasBackup(!!j.has_backup)
        }
      } catch (e) {
        if (!cancelled) setReadErr((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [app.domain, server.ip])

  const dirty = content !== originalContent
  const lineCount = content.split("\n").length

  async function save() {
    if (!content.trim()) {
      onFlash("err", "Refusing to save an empty file"); return
    }
    if (Math.abs(content.length - originalContent.length) > 5000) {
      if (!confirm(`Large change — file size diff is ${Math.abs(content.length - originalContent.length)} bytes. Continue?`)) return
    }
    setSaving(true)
    const fd = new FormData()
    fd.set("domain", app.domain)
    fd.set("server_ip", server.ip)
    fd.set("body", content)
    const r = await fetch("/api/sa/index-file", { method: "POST", body: fd, credentials: "same-origin" })
    const j = await r.json()
    if (j.ok) {
      onFlash("ok", j.message ?? "Saved")
      setOriginalContent(content)
      setHasBackup(true)
    } else {
      onFlash("err", j.error ?? "Save failed")
    }
    setSaving(false)
  }

  async function restore() {
    if (!hasBackup) { onFlash("err", "No backup to restore from"); return }
    if (!confirm("Restore index.php from index.php.bak? Current contents will be overwritten.")) return
    setSaving(true)
    const fd = new FormData()
    fd.set("domain", app.domain)
    fd.set("server_ip", server.ip)
    fd.set("action", "restore")
    const r = await fetch("/api/sa/index-file", { method: "POST", body: fd, credentials: "same-origin" })
    const j = await r.json()
    if (j.ok) {
      onFlash("ok", j.message ?? "Restored")
      // Re-read after restore
      const url = `/api/sa/index-file?domain=${encodeURIComponent(app.domain)}&server_ip=${encodeURIComponent(server.ip)}`
      const rr = await fetch(url, { credentials: "same-origin" }).then((x) => x.json())
      if (rr.ok) {
        setContent(rr.content ?? "")
        setOriginalContent(rr.content ?? "")
      }
    } else {
      onFlash("err", j.error ?? "Restore failed")
    }
    setSaving(false)
  }

  // Esc to close
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); void save() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content])

  // ---- Structured single-app edit ops (mutate local content; user reviews + saves) ----
  function applyOp(op:
    | { kind: "insert_top"; code: string }
    | { kind: "append_end"; code: string }
    | { kind: "search_replace"; find: string; replace: string }
    | { kind: "replace_line"; line: number; replace: string }
    | { kind: "delete_top" }
  ) {
    setContent((c) => {
      switch (op.kind) {
        case "insert_top":
          return op.code + (op.code.endsWith("\n") ? "" : "\n") + c
        case "append_end":
          return c + (c.endsWith("\n") ? "" : "\n") + op.code
        case "search_replace":
          return op.find ? c.split(op.find).join(op.replace) : c
        case "replace_line": {
          const lines = c.split("\n")
          const i = op.line - 1
          if (i < 0 || i >= lines.length) return c
          lines[i] = op.replace
          return lines.join("\n")
        }
        case "delete_top": {
          const lines = c.split("\n")
          if (lines.length === 0) return c
          lines.shift()
          return lines.join("\n")
        }
      }
    })
  }
  function quickInsertTop() {
    const code = window.prompt("Code to insert at the FIRST line:", "")
    if (code) applyOp({ kind: "insert_top", code })
  }
  function quickAppendEnd() {
    const code = window.prompt("Code to append at the END of the file:", "")
    if (code) applyOp({ kind: "append_end", code })
  }
  function quickSearchReplace() {
    const find = window.prompt("Search for (literal text — no regex):", "")
    if (!find) return
    const repl = window.prompt(`Replace all occurrences of "${find.slice(0, 40)}…" with:`, "")
    if (repl == null) return
    applyOp({ kind: "search_replace", find, replace: repl })
  }
  function quickReplaceLine() {
    const lnRaw = window.prompt("Line number to replace (1-indexed):", "1")
    if (!lnRaw) return
    const line = parseInt(lnRaw, 10)
    if (!Number.isFinite(line) || line < 1) { alert("Invalid line number"); return }
    const repl = window.prompt(`New content for line ${line}:`, "")
    if (repl == null) return
    applyOp({ kind: "replace_line", line, replace: repl })
  }
  function quickDeleteTop() {
    const firstLine = content.split("\n")[0] ?? ""
    if (!confirm(
      `Delete the first line?\n\n` +
      `> ${firstLine.slice(0, 100)}${firstLine.length > 100 ? "…" : ""}\n\n` +
      `(applies locally — review with Diff before saving).`,
    )) return
    applyOp({ kind: "delete_top" })
  }

  // ---- SSL reinstall (3-tier: API → patchright UI → SSH) ----
  const [sslBusy, setSslBusy] = React.useState(false)
  async function reinstallSsl() {
    if (!confirm(
      `Re-run SSL install for ${app.domain}?\n\n` +
      `Uses cached Origin CA cert if present, else fetches a fresh 15-year cert from CF. ` +
      `Brief grey-cloud window during SA verification.`,
    )) return
    setSslBusy(true)
    const fd = new FormData()
    fd.set("domain", app.domain)
    const r = await fetch("/api/sa/reinstall-ssl", { method: "POST", body: fd, credentials: "same-origin" })
    const j = await r.json()
    onFlash(j.ok ? "ok" : "err", j.message ?? j.error ?? "SSL reinstall finished")
    setSslBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-background/60 backdrop-blur-[1px]" onClick={onClose} />
      <aside className="flex w-full max-w-3xl flex-col border-l border-border bg-card shadow-2xl">
        <header className="flex items-center justify-between gap-2 border-b border-border px-5 py-3">
          <div className="flex flex-col min-w-0">
            <span className="font-medium truncate">{app.domain || app.name}</span>
            <span className="font-mono text-micro text-muted-foreground truncate">
              {server.sa_name} · {server.ip} · sa_app_id={app.sa_app_id}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs"
              onClick={onUpload}
              title="Upload an arbitrary file (.php / .js / .css / etc.) into /public_html/ alongside index.php"
            >
              <FileUp className="h-3 w-3" /> Upload file
            </Button>
            <Button
              size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs btn-soft-info"
              onClick={reinstallSsl} disabled={sslBusy}
              title="Re-run the 3-tier SSL install (API → UI → SSH) — uses cached Origin CA cert if present"
            >
              <ShieldCheck className={cn("h-3 w-3", sslBusy && "animate-spin")} /> Reinstall SSL
            </Button>
            <a
              href={`https://app.serveravatar.com/organizations/$ORG/servers/${server.sa_server_id}/applications/${app.sa_app_id}`}
              target="_blank" rel="noopener noreferrer"
              title="Open this app in ServerAvatar dashboard"
            >
              <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs">
                <ExternalLink className="h-3 w-3" /> Open in SA
              </Button>
            </a>
            <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0" title="Close (Esc)">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Quick-edit toolbar — applies structured ops to local content; user reviews via diff + saves normally */}
          <div className="flex items-center gap-1 border-b border-border bg-muted/20 px-5 py-1.5">
            <span className="text-micro text-muted-foreground mr-1">Quick edits:</span>
            <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]"
              onClick={quickInsertTop} disabled={loading}
              title="Insert code at the first line of the file">
              <ArrowUp className="h-3 w-3" /> Insert top
            </Button>
            <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]"
              onClick={quickAppendEnd} disabled={loading}
              title="Append code at the end of the file">
              <ArrowDown className="h-3 w-3" /> Append
            </Button>
            <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]"
              onClick={quickSearchReplace} disabled={loading}
              title="Find a literal string and replace all occurrences">
              <Replace className="h-3 w-3" /> Find &amp; replace
            </Button>
            <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]"
              onClick={quickReplaceLine} disabled={loading}
              title="Replace the contents of a specific line by line number">
              <Pencil className="h-3 w-3" /> Replace line…
            </Button>
            <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]"
              onClick={quickDeleteTop} disabled={loading || !content}
              title="Drop the first line of the file">
              <Scissors className="h-3 w-3" /> Delete top
            </Button>
            <span className="ml-auto text-micro text-muted-foreground">
              Operations are applied locally — review with Diff, then Save to write
            </span>
          </div>
          <div className="flex items-center gap-2 border-b border-border px-5 py-2">
            <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-small font-medium">/public_html/index.php</span>
            <span className="text-micro text-muted-foreground">
              {loading ? "loading…" : `${content.length} bytes · ${lineCount} lines`}
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <Button
                size="sm" variant="ghost"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => setShowDiff(!showDiff)}
                disabled={!dirty}
                title="Show changes vs the read-time content"
              >
                <Eye className="h-3 w-3" /> {showDiff ? "Hide diff" : "Diff"}
              </Button>
              <Button
                size="sm" variant="outline"
                className="h-7 gap-1 px-2 text-xs btn-soft-warning"
                onClick={restore}
                disabled={saving || !hasBackup}
                title={hasBackup ? "Restore from index.php.bak" : "No backup found"}
              >
                <RotateCcw className="h-3 w-3" /> Restore .bak
              </Button>
              <Button
                size="sm" variant="outline"
                className="h-7 gap-1 px-2 text-xs btn-soft-success"
                onClick={save}
                disabled={!dirty || saving}
                title="Save (creates index.php.bak first) · Ctrl+S"
              >
                <Save className={cn("h-3 w-3", saving && "animate-spin")} /> Save
              </Button>
            </span>
          </div>

          <div className="flex-1 overflow-hidden">
            {readErr ? (
              <div className="flex h-full items-center justify-center px-5 text-status-terminal">
                <AlertTriangle className="mr-2 h-4 w-4" /> {readErr}
              </div>
            ) : showDiff ? (
              <DiffView original={originalContent} current={content} />
            ) : (
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="h-full min-h-full w-full resize-none rounded-none border-0 bg-card font-mono text-xs leading-relaxed focus-visible:ring-0"
                spellCheck={false}
                disabled={loading}
                placeholder={loading ? "Loading…" : "// index.php content"}
              />
            )}
          </div>
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-border px-5 py-3 text-micro text-muted-foreground">
          <span>{dirty ? "Unsaved changes" : "Up to date with disk"}</span>
          <span>Ctrl+S to save · Esc to close</span>
        </footer>
      </aside>
    </div>
  )
}

function DiffView({ original, current }: { original: string; current: string }) {
  // Lightweight unified line diff — no external dep. Highlights additions
  // (green) + removals (red) + unchanged (muted).
  const o = original.split("\n")
  const c = current.split("\n")
  const max = Math.max(o.length, c.length)
  const rows: { tag: "same" | "add" | "del"; line: string; n: number }[] = []
  for (let i = 0; i < max; i++) {
    const a = o[i]; const b = c[i]
    if (a === b) {
      if (a !== undefined) rows.push({ tag: "same", line: a, n: i + 1 })
    } else {
      if (a !== undefined) rows.push({ tag: "del", line: a, n: i + 1 })
      if (b !== undefined) rows.push({ tag: "add", line: b, n: i + 1 })
    }
  }
  return (
    <pre className="h-full w-full overflow-auto bg-card px-3 py-2 font-mono text-[11px] leading-snug">
      {rows.map((r, i) => (
        <div
          key={i}
          className={cn(
            r.tag === "add" && "bg-status-completed/10 text-status-completed",
            r.tag === "del" && "bg-status-terminal/10 text-status-terminal",
            r.tag === "same" && "text-foreground/60",
          )}
        >
          <span className="inline-block w-9 select-none text-right pr-2 text-muted-foreground/50">{r.n}</span>
          <span className="inline-block w-3 select-none">{r.tag === "add" ? "+" : r.tag === "del" ? "-" : " "}</span>
          {r.line}
        </div>
      ))}
    </pre>
  )
}

// ---------------------------------------------------------------------------
// Bulk edit dialog
// ---------------------------------------------------------------------------

type OpKind = "insert_top" | "append_end" | "search_replace" | "replace_line" | "delete_top"

function BulkEditDialog({
  targets, onClose, onDone,
}: {
  targets: { domain: string; server_ip: string }[]
  onClose: () => void
  onDone: (r: { succeeded: number; failed: number; unchanged: number }) => void
}) {
  const [opKind, setOpKind] = React.useState<OpKind>("insert_top")
  const [code, setCode] = React.useState("")
  const [findStr, setFindStr] = React.useState("")
  const [replaceStr, setReplaceStr] = React.useState("")
  const [lineNum, setLineNum] = React.useState("1")
  const [dryRun, setDryRun] = React.useState(false)
  const [running, setRunning] = React.useState(false)
  const [progress, setProgress] = React.useState<{
    items: { domain: string; ok: boolean; error?: string; bytes_written?: number; unchanged?: boolean }[]
    succeeded: number; failed: number; unchanged: number
  } | null>(null)

  function buildOp(): unknown | null {
    if (opKind === "insert_top" || opKind === "append_end") {
      if (!code.trim()) return null
      return { kind: opKind, code }
    }
    if (opKind === "search_replace") {
      if (!findStr) return null
      return { kind: "search_replace", find: findStr, replace: replaceStr }
    }
    if (opKind === "replace_line") {
      const ln = Number.parseInt(lineNum, 10)
      if (!Number.isFinite(ln) || ln < 1) return null
      return { kind: "replace_line", line: ln, replace: replaceStr }
    }
    if (opKind === "delete_top") {
      return { kind: "delete_top" }
    }
    return null
  }

  async function run() {
    const op = buildOp()
    if (!op) { alert("Operation parameters incomplete"); return }
    if (!dryRun && !confirm(
      `You are about to modify ${targets.length} application(s). Each will get an index.php.bak ` +
      `backup before write. Continue?`,
    )) return
    setRunning(true); setProgress(null)
    const r = await fetch("/api/sa/bulk-edit", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets, op, dry_run: dryRun, concurrency: 5 }),
    })
    const j = await r.json()
    setRunning(false)
    if (!j.ok) {
      alert(`Bulk edit failed: ${j.error}`); return
    }
    setProgress({ items: j.items, succeeded: j.succeeded, failed: j.failed, unchanged: j.unchanged })
    if (!dryRun) onDone({ succeeded: j.succeeded, failed: j.failed, unchanged: j.unchanged })
  }

  return (
    <OperatorDialog
      open={true}
      onOpenChange={(o) => { if (!o) onClose() }}
      title={`Bulk edit index.php — ${targets.length} app(s)`}
      description={
        "Each selected app gets a backup at /public_html/index.php.bak before its index.php is " +
        "rewritten. Concurrency capped at 5. Failures don't abort the batch — they're listed in the result."
      }
      submitLabel={dryRun ? "Run dry-run" : running ? "Running…" : "Apply to all"}
      onSubmit={run}
    >
      <FieldGroup>
        <Field>
          <FieldLabel>Operation</FieldLabel>
          <Select value={opKind} onValueChange={(v) => setOpKind(v as OpKind)}>
            <SelectTrigger size="sm" className="h-8 text-small"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="insert_top">Insert at top</SelectItem>
              <SelectItem value="append_end">Append at end</SelectItem>
              <SelectItem value="search_replace">Search &amp; replace</SelectItem>
              <SelectItem value="replace_line">Replace specific line</SelectItem>
              <SelectItem value="delete_top">Delete first line</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {(opKind === "insert_top" || opKind === "append_end") && (
          <Field>
            <FieldLabel>Code to insert</FieldLabel>
            <Textarea
              value={code} onChange={(e) => setCode(e.target.value)}
              rows={6} className="font-mono text-xs"
              placeholder={`<?php // ${opKind === "insert_top" ? "prepended" : "appended"} block`}
            />
          </Field>
        )}

        {opKind === "search_replace" && (
          <>
            <Field>
              <FieldLabel>Find (literal — no regex)</FieldLabel>
              <Textarea value={findStr} onChange={(e) => setFindStr(e.target.value)} rows={3} className="font-mono text-xs" />
            </Field>
            <Field>
              <FieldLabel>Replace with</FieldLabel>
              <Textarea value={replaceStr} onChange={(e) => setReplaceStr(e.target.value)} rows={3} className="font-mono text-xs" />
            </Field>
          </>
        )}

        {opKind === "replace_line" && (
          <>
            <Field>
              <FieldLabel>Line number (1-indexed)</FieldLabel>
              <Input
                type="number" min={1}
                value={lineNum} onChange={(e) => setLineNum(e.target.value)}
                className="h-8 text-small"
              />
            </Field>
            <Field>
              <FieldLabel>New line content</FieldLabel>
              <Textarea value={replaceStr} onChange={(e) => setReplaceStr(e.target.value)} rows={2} className="font-mono text-xs" />
              <FieldDescription>Replaces only on apps where that line exists; others unchanged.</FieldDescription>
            </Field>
          </>
        )}

        {opKind === "delete_top" && (
          <div className="rounded-md border border-status-waiting/30 bg-status-waiting/5 px-3 py-2 text-small text-foreground/80">
            Drops the <strong>first line</strong> of every selected app's <code className="font-mono">index.php</code>.
            No parameters — the operation is identical across all targets.
            Useful for stripping a stray header (a misplaced <code className="font-mono">&lt;?php</code>,
            an injected analytics line, or a leftover marker).
          </div>
        )}

        <label className="inline-flex items-center gap-2 text-small">
          <Checkbox checked={dryRun} onCheckedChange={(v) => setDryRun(Boolean(v))} />
          Dry run — simulate without writing (just shows would-be byte counts)
        </label>

        {progress && (
          <div className="mt-2 rounded-md border border-border bg-muted/30 px-3 py-2">
            <div className="flex items-center gap-3 text-small">
              <span className="text-status-completed flex items-center gap-1"><Check className="h-3 w-3" /> {progress.succeeded} ok</span>
              <span className="text-status-terminal flex items-center gap-1"><X className="h-3 w-3" /> {progress.failed} failed</span>
              <span className="text-muted-foreground flex items-center gap-1"><Activity className="h-3 w-3" /> {progress.unchanged} unchanged</span>
            </div>
            <div className="mt-2 max-h-48 overflow-y-auto font-mono text-[11px]">
              {progress.items.map((it, i) => (
                <div key={i} className={cn(
                  "flex items-baseline gap-2",
                  !it.ok && "text-status-terminal",
                  it.ok && it.unchanged && "text-muted-foreground",
                )}>
                  <span className="w-3">{it.ok ? (it.unchanged ? "·" : "✓") : "✗"}</span>
                  <span className="flex-1 truncate">{it.domain}</span>
                  <span>{it.ok
                    ? (it.unchanged ? "no change" : `${it.bytes_written ?? 0}B`)
                    : (it.error ?? "error").slice(0, 80)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </FieldGroup>
    </OperatorDialog>
  )
}

// ---------------------------------------------------------------------------
// Upload-file dialog — single OR bulk, paste OR file picker
// ---------------------------------------------------------------------------

type UploadCtx =
  | { mode: "single"; domain: string; server_ip: string }
  | { mode: "bulk"; targets: { domain: string; server_ip: string }[] }

function UploadFileDialog({
  ctx, onClose, onDone,
}: {
  ctx: UploadCtx
  onClose: () => void
  onDone: (message: string, ok: boolean) => void
}) {
  const [filename, setFilename] = React.useState("")
  const [body, setBody] = React.useState("")
  const [picked, setPicked] = React.useState<File | null>(null)
  const [running, setRunning] = React.useState(false)
  const [bulkProgress, setBulkProgress] = React.useState<{
    items: { domain: string; ok: boolean; bytes_written?: number; via?: string; error?: string }[]
    succeeded: number; failed: number
  } | null>(null)

  const targetCount = ctx.mode === "bulk" ? ctx.targets.length : 1

  async function readPickedFile(): Promise<string | null> {
    if (!picked) return null
    return new Promise<string | null>((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(typeof r.result === "string" ? r.result : null)
      r.onerror = () => resolve(null)
      r.readAsText(picked)
    })
  }

  async function submit() {
    const fname = filename.trim()
    if (!fname) { alert("Filename required"); return }
    let content = body
    if (picked) {
      const fromFile = await readPickedFile()
      if (fromFile == null) { alert("Failed to read selected file"); return }
      content = fromFile
      // If filename input is empty, use the picked file's name
      if (!filename.trim() && picked.name) setFilename(picked.name)
    }
    if (!content) { alert("Content cannot be empty"); return }
    if (ctx.mode === "bulk" && !confirm(
      `Upload ${fname} (${content.length} bytes) to ${targetCount} app(s)?\n\n` +
      `Lands in /public_html/ on each. Existing files with the same name are overwritten.`,
    )) return

    setRunning(true); setBulkProgress(null)
    if (ctx.mode === "single") {
      const r = await fetch("/api/sa/upload-file", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: ctx.domain, server_ip: ctx.server_ip,
          filename: fname, body: content,
        }),
      })
      const j = await r.json()
      setRunning(false)
      onDone(j.message ?? j.error ?? (j.ok ? "Uploaded" : "Upload failed"), !!j.ok)
      return
    }
    // bulk
    const r = await fetch("/api/sa/upload-file", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targets: ctx.targets,
        filename: fname, body: content, concurrency: 5,
      }),
    })
    const j = await r.json()
    setRunning(false)
    if (!j.ok) { alert(`Bulk upload failed: ${j.error}`); return }
    setBulkProgress({ items: j.items, succeeded: j.succeeded, failed: j.failed })
    onDone(j.message ?? `Uploaded to ${j.succeeded}/${targetCount}`, j.failed === 0)
  }

  return (
    <OperatorDialog
      open={true}
      onOpenChange={(o) => { if (!o) onClose() }}
      title={ctx.mode === "single"
        ? `Upload file → ${ctx.domain}`
        : `Bulk upload file → ${targetCount} app(s)`}
      description={
        "Lands top-level in /public_html/. Any extension works (.php / .js / .css / .html / .txt / etc.). " +
        "Existing files with the same name are OVERWRITTEN — there's no automatic backup for arbitrary " +
        "uploads, only index.php gets a .bak."
      }
      submitLabel={running ? "Uploading…" : ctx.mode === "single" ? "Upload" : "Upload to all"}
      onSubmit={submit}
    >
      <FieldGroup>
        <Field>
          <FieldLabel>Filename</FieldLabel>
          <Input
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder="e.g. style.css, tracker.js, notice.html"
            className="h-8 text-small font-mono"
            disabled={running}
          />
          <FieldDescription>
            Top-level only · alphanumeric start · [A-Za-z0-9._-] · max 128 chars ·
            no slashes / `..` · index.php.bak and .htaccess are reserved.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel>Pick a file (optional)</FieldLabel>
          <label className="flex items-center gap-2 cursor-pointer rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 hover:bg-muted/50 text-small">
            <Upload className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">
              {picked ? `${picked.name} (${picked.size} bytes)` : "Click to choose a text file"}
            </span>
            <input
              type="file" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null
                setPicked(f)
                if (f && !filename.trim()) setFilename(f.name)
              }}
            />
            {picked && (
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); setPicked(null) }}
                className="ml-auto text-micro text-muted-foreground hover:text-foreground"
              >clear</button>
            )}
          </label>
          <FieldDescription>
            If a file is picked, its contents are uploaded — the textarea below is ignored.
            Text-only for now (binary uploads aren't supported via this path).
          </FieldDescription>
        </Field>

        {!picked && (
          <Field>
            <FieldLabel>Or paste content</FieldLabel>
            <Textarea
              value={body} onChange={(e) => setBody(e.target.value)}
              rows={10} className="font-mono text-xs"
              placeholder="// file contents"
              disabled={running}
            />
          </Field>
        )}

        {bulkProgress && (
          <div className="mt-2 rounded-md border border-border bg-muted/30 px-3 py-2">
            <div className="flex items-center gap-3 text-small">
              <span className="text-status-completed flex items-center gap-1">
                <Check className="h-3 w-3" /> {bulkProgress.succeeded} ok
              </span>
              <span className="text-status-terminal flex items-center gap-1">
                <X className="h-3 w-3" /> {bulkProgress.failed} failed
              </span>
            </div>
            <div className="mt-2 max-h-48 overflow-y-auto font-mono text-[11px]">
              {bulkProgress.items.map((it, i) => (
                <div key={i} className={cn(
                  "flex items-baseline gap-2",
                  !it.ok && "text-status-terminal",
                )}>
                  <span className="w-3">{it.ok ? "✓" : "✗"}</span>
                  <span className="flex-1 truncate">{it.domain}</span>
                  <span>{it.ok
                    ? `${it.bytes_written ?? 0}B via ${it.via}`
                    : (it.error ?? "error").slice(0, 80)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </FieldGroup>
    </OperatorDialog>
  )
}
