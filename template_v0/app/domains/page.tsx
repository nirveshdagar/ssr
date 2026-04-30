"use client"

import * as React from "react"
import {
  Search,
  Plus,
  Filter,
  Play,
  Eye,
  EyeOff,
  History,
  Ban,
  Trash2,
  Archive,
  ChevronDown,
  Download,
  Upload,
  X,
  RefreshCw,
  StopCircle,
  Cloud,
  Server as ServerIcon,
  FileUp,
  Info,
  ArrowLeftRight,
  Lock,
  Unlock,
  Loader2,
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
import { type PipelineStatus } from "@/lib/ssr/mock-data"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { useDomains } from "@/hooks/use-domains"
import { useServers } from "@/hooks/use-servers"
import { useCfKeys } from "@/hooks/use-cf-keys"
import { domainActions } from "@/lib/api-actions"
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectLabel, SelectItem,
} from "@/components/ui/select"
import { OperatorDialog } from "@/components/ssr/operator-dialog"
import { FileBrowserDialog } from "@/components/ssr/file-browser-dialog"
import { ModelPicker } from "@/components/ssr/model-picker"
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { PIPELINE_STEPS } from "@/lib/status-taxonomy"
import { RAW_STATUSES, RAW_STATUS_GROUPS } from "@/lib/ssr/domain-statuses"
import { cn } from "@/lib/utils"

// Coarse "chip" filters — match the 7 most common buckets.
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
  return (
    <React.Suspense fallback={null}>
      <DomainsPageInner />
    </React.Suspense>
  )
}

function DomainsPageInner() {
  // Filters live in URL search params so the view is shareable + bookmarkable.
  // Initial state hydrates from `?status=…&raw=…&q=…`; mutations push back via
  // router.replace so reload + back/forward both round-trip cleanly.
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const initialFilter = (sp.get("status") as PipelineStatus | "all" | null) ?? "all"
  const initialRaw = sp.get("raw")
  const initialQuery = sp.get("q") ?? ""
  const [filter, setFilter] = React.useState<PipelineStatus | "all">(initialFilter)
  /** When non-null, takes precedence over the chip filter — this is the
   *  fine-grained 22-status dropdown matching Flask's domains.html. */
  const [rawStatusFilter, setRawStatusFilter] = React.useState<string | null>(initialRaw)
  const [query, setQuery] = React.useState(initialQuery)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())

  // Push filter state to URL. Throttle the search box via a tiny debounce so
  // every keystroke doesn't flood router.replace (it's cheap, but cleaner).
  React.useEffect(() => {
    const params = new URLSearchParams()
    if (filter !== "all") params.set("status", filter)
    if (rawStatusFilter) params.set("raw", rawStatusFilter)
    if (query.trim()) params.set("q", query)
    const qs = params.toString()
    const target = qs ? `${pathname}?${qs}` : pathname
    const id = window.setTimeout(() => {
      router.replace(target, { scroll: false })
    }, 250)
    return () => window.clearTimeout(id)
  }, [filter, rawStatusFilter, query, pathname, router])

  const { rows: DOMAINS, isLoading, refresh } = useDomains()
  const { rows: SERVERS } = useServers()
  const { rows: CF_KEYS } = useCfKeys()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [flash, setFlash] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)

  // Lookup tables for the row rendering — match Flask's `cf_keys_by_id` /
  // `servers_by_id` so we can show "alias + email" in the CF column and
  // "ip · name · region" in the Server column instead of "cf-N" / "srv-N".
  const cfKeysById = React.useMemo(
    () => Object.fromEntries(CF_KEYS.map((k) => [Number(k.id), k] as const)),
    [CF_KEYS],
  )
  const serversById = React.useMemo(
    () => Object.fromEntries(SERVERS.map((s) => [Number(s.id), s] as const)),
    [SERVERS],
  )

  // Add Domains dialog (replaces the old window.prompt chain)
  const [addOpen, setAddOpen] = React.useState(false)
  const [addText, setAddText] = React.useState("")
  const [addResult, setAddResult] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)

  // Import CSV dialog (Flask shows a hint about optional cf_email/cf_global_key/cf_zone_id columns)
  const [importOpen, setImportOpen] = React.useState(false)
  const [importFile, setImportFile] = React.useState<File | null>(null)
  const [importResult, setImportResult] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)

  // Bulk-run options (Flask's bulk form has skip_purchase + server picker)
  const [bulkSkipPurchase, setBulkSkipPurchase] = React.useState(false)
  const [bulkServerId, setBulkServerId] = React.useState<string>("")
  // Per-bulk LLM override — same shape as the single-run modal. Lets the
  // operator route step 9 across the whole batch to a fallback provider when
  // the default one is rate-limited.
  const [bulkCustomProvider, setBulkCustomProvider] = React.useState<string>("")
  const [bulkCustomModel, setBulkCustomModel] = React.useState<string>("")

  // CF credentials password show/hide (Flask has the eye toggle)
  const [cfShowKey, setCfShowKey] = React.useState(false)

  // Pipeline Run modal state — replaces window.prompt for the per-row "Run"
  // button. Supports skip_purchase, start_from (auto + 1..10), server_id,
  // and an inline preflight panel that calls /api/preflight/[domain].
  const [runModalDomain, setRunModalDomain] = React.useState<string | null>(null)
  const [runOpts, setRunOpts] = React.useState<{
    skipPurchase: boolean; startFrom: string; serverId: string
    customProvider: string; customModel: string
  }>({ skipPurchase: false, startFrom: "", serverId: "", customProvider: "", customModel: "" })
  const [preflightResult, setPreflightResult] = React.useState<
    { ok: boolean; checks: Record<string, { ok: boolean; message: string }> } | null
  >(null)
  const [runResult, setRunResult] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)

  function openRunModal(domain: string) {
    setRunModalDomain(domain)
    setRunOpts({ skipPurchase: false, startFrom: "", serverId: "", customProvider: "", customModel: "" })
    setPreflightResult(null)
    setRunResult(null)
  }
  async function runPreflight() {
    if (!runModalDomain) return
    const r = await domainActions.preflight(runModalDomain, runOpts.skipPurchase)
    if (r.ok && r.data) {
      setPreflightResult(r.data as typeof preflightResult)
    } else {
      setRunResult({ kind: "err", text: r.error ?? "Preflight failed" })
    }
  }
  async function submitRunPipeline() {
    if (!runModalDomain) return
    const opts: {
      skipPurchase?: boolean
      serverId?: number
      startFrom?: number
      forceNewServer?: boolean
      customProvider?: string
      customModel?: string
    } = {
      skipPurchase: runOpts.skipPurchase,
    }
    if (runOpts.serverId === "__new__") opts.forceNewServer = true
    else if (runOpts.serverId) opts.serverId = Number(runOpts.serverId)
    if (runOpts.startFrom) opts.startFrom = Number(runOpts.startFrom)
    if (runOpts.customProvider) opts.customProvider = runOpts.customProvider
    if (runOpts.customModel.trim()) opts.customModel = runOpts.customModel.trim()
    const r = await domainActions.runPipeline(runModalDomain, opts)
    if (r.ok) {
      setRunModalDomain(null)
      show("ok", r.message ?? "Pipeline started")
      await refresh()
    } else {
      setRunResult({ kind: "err", text: r.error ?? r.message ?? "run failed" })
    }
  }

  // Run History modal state — shows /api/domains/[domain]/runs list, with
  // drill-down to /api/runs/[id] for per-step detail.
  const [historyDomain, setHistoryDomain] = React.useState<string | null>(null)
  const [historyRuns, setHistoryRuns] = React.useState<Array<{
    id: number; status: string; started_at: number | null; ended_at: number | null;
    error: string | null; params_json: string | null
  }> | null>(null)
  const [historyDetail, setHistoryDetail] = React.useState<{
    runId: number
    steps: Array<{ step_num: number; status: string; message: string | null;
      started_at: number | null; ended_at: number | null;
      artifact_json: string | null }>
  } | null>(null)

  async function openHistoryModal(domain: string) {
    setHistoryDomain(domain)
    setHistoryRuns(null)
    setHistoryDetail(null)
    const r = await fetch(`/api/domains/${domain}/runs?limit=20`, { credentials: "same-origin" })
    if (r.ok) {
      const j = (await r.json()) as { runs: typeof historyRuns }
      setHistoryRuns(j.runs ?? [])
    }
  }
  async function openRunDetail(runId: number) {
    setHistoryDetail({ runId, steps: [] })
    const r = await fetch(`/api/runs/${runId}`, { credentials: "same-origin" })
    if (r.ok) {
      type Step = NonNullable<typeof historyDetail>["steps"][number]
      const j = (await r.json()) as { run: unknown; steps: Step[] }
      setHistoryDetail({ runId, steps: j.steps ?? [] })
    }
  }
  async function retryFromStep(domain: string, step: number) {
    const r = await domainActions.runFromStep(domain, step)
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
    if (r.ok) setHistoryDomain(null)
    await refresh()
  }

  // CF Credentials modal — edit cf_email/cf_global_key/cf_zone_id per domain.
  const [cfModalDomain, setCfModalDomain] = React.useState<string | null>(null)
  const [cfFields, setCfFields] = React.useState<{ email: string; key: string; zone: string }>(
    { email: "", key: "", zone: "" },
  )
  const [cfResult, setCfResult] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)
  function openCfModal(domain: string) {
    setCfModalDomain(domain)
    setCfFields({ email: "", key: "", zone: "" })
    setCfResult(null)
  }

  // Per-domain file browser — list/upload/delete files in /public_html.
  // Server IP is looked up via the domain row's serverId at click time.
  const [filesDomain, setFilesDomain] = React.useState<string>("")
  const [filesServerIp, setFilesServerIp] = React.useState<string>("")
  function openFiles(domain: string, serverIp: string) {
    setFilesDomain(domain)
    setFilesServerIp(serverIp)
  }

  // SSL one-click repair — clicking the red lock enqueues a pipeline.full from
  // step 8 (skip-purchase). We track the domain in a Set so the icon shows a
  // spinner while the job is in flight; auto-heal's SSL sweep (every 5 min)
  // and the periodic data refresh will flip the lock green once the new cert
  // verifies. Drop the busy state after 120s either way so a stuck job doesn't
  // pin the spinner forever.
  const [sslFixing, setSslFixing] = React.useState<Set<string>>(new Set())
  async function fixSsl(name: string) {
    if (sslFixing.has(name)) return
    setSslFixing((s) => new Set([...s, name]))
    const r = await domainActions.runFromStep(name, 8, { skipPurchase: true })
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? "ssl repair failed")
    void refresh()
    window.setTimeout(() => {
      setSslFixing((s) => {
        if (!s.has(name)) return s
        const n = new Set(s); n.delete(name); return n
      })
    }, 120_000)
  }

  // Force a fresh SSL probe for one domain — used when the lock disagrees
  // with the operator's expectation (e.g. green but they know the cert was
  // removed). Bypasses the 5-min sweep cadence and writes ssl_origin_ok
  // immediately, so the icon flips on the next refresh tick.
  const [sslChecking, setSslChecking] = React.useState<Set<string>>(new Set())
  async function recheckSsl(name: string) {
    if (sslChecking.has(name)) return
    setSslChecking((s) => new Set([...s, name]))
    const r = await domainActions.checkSslNow(name) as {
      ok: boolean
      data?: {
        probed_ip?: string
        result?: boolean | null
        issuer?: string | null
        subject?: string | null
        message?: string
      }
      error?: string
    }
    if (!r.ok) {
      show("err", r.error ?? "SSL re-probe failed")
    } else {
      const d = r.data ?? {}
      const verdict =
        d.result === true ? "ok" :
        d.result === false ? "err" :
        "ok"
      const text =
        d.result === true ? `SSL verified — issuer=${d.issuer ?? "?"}` :
        d.result === false ? `SSL MISMATCH on ${d.probed_ip ?? "origin"} — issuer=${d.issuer ?? "?"} subject=${d.subject ?? "?"}` :
        `SSL probe inconclusive: ${d.message ?? ""}`
      show(verdict, text)
    }
    void refresh()
    setSslChecking((s) => {
      if (!s.has(name)) return s
      const n = new Set(s); n.delete(name); return n
    })
  }
  async function submitCfUpdate() {
    if (!cfModalDomain) return
    const r = await domainActions.updateCf(cfModalDomain, {
      cf_email: cfFields.email || undefined,
      cf_global_key: cfFields.key || undefined,
      cf_zone_id: cfFields.zone || undefined,
    })
    if (r.ok) {
      setCfModalDomain(null); show("ok", r.message ?? "CF credentials updated")
      await refresh()
    } else {
      setCfResult({ kind: "err", text: r.error ?? r.message ?? "update failed" })
    }
  }

  const eligibleServers = SERVERS.filter((s) => s.status === "active" && s.id)

  function show(kind: "ok" | "err", text: string) {
    setFlash({ kind, text })
    window.setTimeout(() => setFlash(null), 4500)
  }

  async function runOne(name: string) {
    setBusy(name)
    const r = await domainActions.runPipeline(name)
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
    await refresh(); setBusy(null)
  }
  async function cancelOne(name: string) {
    if (!confirm(
      `Cancel pipeline for ${name}?\n\n` +
      `Cancel is GRACEFUL — the worker checks the cancel flag at each step boundary, ` +
      `so a long step (e.g., the 5–15 min SA agent install during step 6) finishes ` +
      `before the cancel takes effect.`,
    )) return
    setBusy(name)
    const r = await domainActions.cancelPipeline(name)
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
    await refresh(); setBusy(null)
  }
  async function softDeleteOne(name: string) {
    if (!confirm(
      `Remove ${name} from dashboard ONLY?\n\n` +
      `The SA app, CF zone, and Spaceship record stay intact. ` +
      `The CF key pool slot is released so the next domain can claim it.`,
    )) return
    setBusy(name)
    const r = await domainActions.delete(name)
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
    await refresh(); setBusy(null)
  }
  async function hardDeleteOne(name: string) {
    if (!confirm(
      `FULL DELETE ${name}?\n\n` +
      `Removes from: SA, CF, Spaceship, DB.\n` +
      `Cannot be undone!`,
    )) return
    setBusy(name)
    const r = await domainActions.fullDelete(name)
    show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
    await refresh(); setBusy(null)
  }
  function describeBulkOverrides(): string {
    const parts: string[] = []
    if (bulkSkipPurchase) parts.push("Skip purchase = ON")
    if (bulkServerId === "__new__") parts.push("Server = NEW droplet")
    else if (bulkServerId) parts.push(`Server = #${bulkServerId}`)
    if (bulkCustomProvider) parts.push(`LLM = ${bulkCustomProvider}${bulkCustomModel ? ` / ${bulkCustomModel}` : ""}`)
    return parts.length ? `\n\nOverrides: ${parts.join(", ")}` : ""
  }
  async function bulkRun() {
    if (!confirm(
      `Run pipeline on ${selected.size} domain(s) IN PARALLEL?\n\n` +
      `Up to SSR_JOB_WORKERS (default 4, configurable) run at the same time. ` +
      `Best when domains are spread across multiple CF keys / servers.` +
      describeBulkOverrides(),
    )) return
    setBusy("bulk")
    const opts: {
      skipPurchase?: boolean; serverId?: number; forceNewServer?: boolean
      customProvider?: string; customModel?: string
    } = {}
    if (bulkSkipPurchase) opts.skipPurchase = true
    if (bulkServerId === "__new__") opts.forceNewServer = true
    else if (bulkServerId) opts.serverId = Number(bulkServerId)
    if (bulkCustomProvider) opts.customProvider = bulkCustomProvider
    if (bulkCustomModel.trim()) opts.customModel = bulkCustomModel.trim()
    const r = await domainActions.runBulk([...selected], opts) as { ok?: boolean; message?: string; error?: string }
    show(r.ok ? "ok" : "err", String(r.message ?? r.error ?? ""))
    setSelected(new Set()); setBulkSkipPurchase(false); setBulkServerId("")
    setBulkCustomProvider(""); setBulkCustomModel("")
    await refresh(); setBusy(null)
  }
  async function bulkRunSequential() {
    if (!confirm(
      `Run pipeline on ${selected.size} domain(s) ONE BY ONE?\n\n` +
      `Domains process in order — the next starts only after the previous ` +
      `finishes (or fails). Smallest blast radius on external APIs; longest ` +
      `total wall-time. Good for small batches (5–10) or when you want a ` +
      `predictable order.` +
      describeBulkOverrides(),
    )) return
    setBusy("bulk")
    const opts: {
      skipPurchase?: boolean; serverId?: number; forceNewServer?: boolean
      customProvider?: string; customModel?: string
    } = {}
    if (bulkSkipPurchase) opts.skipPurchase = true
    if (bulkServerId === "__new__") opts.forceNewServer = true
    else if (bulkServerId) opts.serverId = Number(bulkServerId)
    if (bulkCustomProvider) opts.customProvider = bulkCustomProvider
    if (bulkCustomModel.trim()) opts.customModel = bulkCustomModel.trim()
    const r = await domainActions.runBulkSequential([...selected], opts) as { ok?: boolean; message?: string; error?: string }
    show(r.ok ? "ok" : "err", String(r.message ?? r.error ?? ""))
    setSelected(new Set()); setBulkSkipPurchase(false); setBulkServerId("")
    setBulkCustomProvider(""); setBulkCustomModel("")
    await refresh(); setBusy(null)
  }
  // ---- Bulk migrate-to-server dialog ----
  const [migrateOpen, setMigrateOpen] = React.useState(false)
  const [migrateTarget, setMigrateTarget] = React.useState<string>("__auto__")
  const [migrateResult, setMigrateResult] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)
  function openBulkMigrate() {
    setMigrateTarget("__auto__")
    setMigrateResult(null)
    setMigrateOpen(true)
  }
  async function submitBulkMigrate() {
    const opts: { targetServerId?: number; forceNewServer?: boolean } = {}
    if (migrateTarget === "__new__") opts.forceNewServer = true
    else if (migrateTarget !== "__auto__") opts.targetServerId = Number(migrateTarget)
    setBusy("bulk")
    const r = await domainActions.bulkMigrate([...selected], opts) as
      { ok?: boolean; job_id?: number; count?: number; message?: string; error?: string }
    if (r.ok) {
      show("ok", r.message ?? `Bulk migrate enqueued for ${r.count} domain(s) (job #${r.job_id})`)
      setMigrateOpen(false)
      setSelected(new Set())
      await refresh()
    } else {
      setMigrateResult({ kind: "err", text: r.error ?? r.message ?? "bulk migrate failed" })
    }
    setBusy(null)
  }

  async function bulkSoftDelete() {
    if (!confirm(
      `Remove ${selected.size} domain(s) from dashboard ONLY?\n\n` +
      `SA apps, CF zones, and Spaceship records stay intact. CF pool slots are released.`,
    )) return
    setBusy("bulk")
    const r = await domainActions.bulkDelete([...selected], "db_only") as { ok?: boolean; message?: string; error?: string }
    show(r.ok ? "ok" : "err", String(r.message ?? r.error ?? ""))
    setSelected(new Set()); await refresh(); setBusy(null)
  }
  async function bulkHardDelete() {
    if (!confirm(
      `FULL DELETE ${selected.size} domain(s) — ONE BY ONE?\n\n` +
      `Removes from: SA, CF, Spaceship, DB.\n` +
      `Runs sequentially in a single worker (~10–15 s per domain). ` +
      `Smallest external-API blast radius. Cannot be undone!`,
    )) return
    setBusy("bulk")
    const r = await domainActions.bulkDelete([...selected], "all") as { ok?: boolean; message?: string; error?: string }
    show(r.ok ? "ok" : "err", String(r.message ?? r.error ?? ""))
    setSelected(new Set()); await refresh(); setBusy(null)
  }
  async function bulkHardDeleteParallel() {
    if (!confirm(
      `FULL DELETE ${selected.size} domain(s) — IN PARALLEL?\n\n` +
      `Removes from: SA, CF, Spaceship, DB.\n` +
      `Runs up to SSR_JOB_WORKERS teardowns at a time (default 4). ` +
      `Per-CF-key semaphore (5/key) + Spaceship throttle still apply, ` +
      `so per-key burst stays bounded. Total wall-time drops by ~Nx. ` +
      `Cannot be undone!`,
    )) return
    setBusy("bulk")
    const r = await domainActions.bulkDelete([...selected], "all_parallel") as { ok?: boolean; message?: string; error?: string }
    show(r.ok ? "ok" : "err", String(r.message ?? r.error ?? ""))
    setSelected(new Set()); await refresh(); setBusy(null)
  }
  async function bulkCancel() {
    if (!confirm(
      `Request cancel on ${selected.size} pipeline(s)?\n\n` +
      `Cancel is GRACEFUL — each worker checks the cancel flag at step boundaries. ` +
      `A long step (e.g., the 5–15 min SA agent install) finishes before stop takes effect.`,
    )) return
    setBusy("bulk")
    const sel = [...selected]
    const names = DOMAINS.filter((d) => selected.has(d.id)).map((d) => d.name)
    let okCount = 0
    for (const n of names) {
      const r = await domainActions.cancelPipeline(n)
      if (r.ok) okCount++
    }
    show("ok", `Cancel requested on ${okCount}/${sel.length}`)
    setSelected(new Set()); await refresh(); setBusy(null)
  }
  function openAddDialog() {
    setAddText("")
    setAddResult(null)
    setAddOpen(true)
  }
  async function submitAdd() {
    const list = addText.replace(/,/g, "\n").split("\n").map((s) => s.trim()).filter(Boolean)
    if (!list.length) {
      setAddResult({ kind: "err", text: "Paste at least one domain (one per line)" }); return
    }
    const fd = new FormData()
    fd.set("domains", list.join("\n"))
    const r = await fetch("/api/domains", { method: "POST", body: fd, credentials: "same-origin" })
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; count?: number; skipped?: number; error?: string }
    if (j.ok) {
      setAddOpen(false)
      show("ok", `Added ${j.count ?? 0}${j.skipped ? `, skipped ${j.skipped}` : ""}`)
      await refresh()
    } else {
      setAddResult({ kind: "err", text: j.error ?? "Add failed" })
    }
  }

  function openImportDialog() {
    setImportFile(null)
    setImportResult(null)
    setImportOpen(true)
  }
  async function submitImport() {
    if (!importFile) {
      setImportResult({ kind: "err", text: "Pick a .csv file first" }); return
    }
    const fd = new FormData()
    fd.set("csv_file", importFile)
    const r = await fetch("/api/domains/import", { method: "POST", body: fd, credentials: "same-origin" })
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; count?: number; error?: string }
    if (j.ok) {
      setImportOpen(false)
      show("ok", `Imported ${j.count ?? 0} rows`)
      await refresh()
    } else {
      setImportResult({ kind: "err", text: j.error ?? "Import failed" })
    }
  }

  // Multi-domain exact-match mode: paste a CSV/newline list to filter for those
  // exact domain names. Otherwise fall back to substring match across name.
  const queryTokens = query.split(/[,\n]/).map((t) => t.trim()).filter(Boolean)
  const isBulkListMode = queryTokens.length > 1
  const tokenSet = new Set(queryTokens.map((t) => t.toLowerCase()))

  const filtered = DOMAINS.filter((d) => {
    // Raw-status dropdown wins over the coarse chip when both are set
    if (rawStatusFilter) {
      if (d.rawStatus !== rawStatusFilter) return false
    } else if (filter !== "all" && d.status !== filter) {
      return false
    }
    if (isBulkListMode) {
      if (!tokenSet.has(d.name.toLowerCase())) return false
    } else if (query.trim()) {
      if (!d.name.toLowerCase().includes(query.toLowerCase().trim())) return false
    }
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
          {/* Check NS (bulk) — green soft, matches Flask */}
          <Button
            variant="outline" size="sm"
            className="gap-1.5 hidden md:inline-flex btn-soft-success"
            onClick={async () => {
              setBusy("check-ns"); show("ok", "Checking NS for every domain with CF creds…")
              const r = await domainActions.checkAllNs() as { ok?: boolean; active?: number; pending?: number; errors?: number }
              show(r.ok ? "ok" : "err",
                r.ok ? `NS check: ${r.active ?? 0} active · ${r.pending ?? 0} pending · ${r.errors ?? 0} errors`
                     : "NS check failed")
              setBusy(null); await refresh()
            }}
            disabled={busy === "check-ns"}
          >
            <Filter className="h-3.5 w-3.5" /> Check NS
          </Button>
          {/* Export CSV — neutral */}
          <a href="/api/domains/export" download="ssr_domains.csv">
            <Button
              variant="outline" size="sm" className="gap-1.5 hidden md:inline-flex"
              title="Download every domain row as a CSV (preserves cf_* + server_id)"
            >
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
          </a>
          {/* Import CSV — neutral, opens dialog with column hint */}
          <Button
            variant="outline" size="sm"
            className="gap-1.5 hidden md:inline-flex"
            onClick={openImportDialog}
            title="Import a CSV — bulk-add domains and optionally restore CF credentials"
          >
            <Upload className="h-3.5 w-3.5" /> Import CSV
          </Button>
          {/* Import from ServerAvatar — blue soft, matches Flask */}
          <Button
            variant="outline" size="sm"
            className="gap-1.5 hidden md:inline-flex btn-soft-info"
            onClick={async () => {
              if (!confirm("Import only the domains hosted as apps on your ServerAvatar servers? (Ignores un-hosted Spaceship domains.)")) return
              setBusy("import-sa")
              const r = await domainActions.importFromSa()
              show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
              setBusy(null); await refresh()
            }}
            disabled={busy === "import-sa"}
            title="Pull every domain hosted on SA + auto-create missing server rows"
          >
            <Plus className="h-3.5 w-3.5" /> Import from SA
          </Button>
          {/* Sync from ServerAvatar — amber soft, matches Flask */}
          <Button
            variant="outline" size="sm"
            className="gap-1.5 hidden md:inline-flex btn-soft-warning"
            onClick={async () => {
              if (!confirm("Remove dashboard rows whose SA app no longer exists upstream? Only touches hosted/live domains.")) return
              setBusy("sync-sa")
              const r = await domainActions.syncFromSa()
              show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
              setBusy(null); await refresh()
            }}
            disabled={busy === "sync-sa"}
            title="Drop dashboard rows whose SA app was deleted elsewhere"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Sync from SA
          </Button>
          {/* Run pipeline on currently filtered domains — bulk runner */}
          <Button
            variant="outline" size="sm"
            className="gap-1.5 hidden lg:inline-flex btn-soft-success"
            onClick={async () => {
              const ids = filtered.map((d) => d.id)
              if (!ids.length) { show("err", "No domains in current filter"); return }
              if (!confirm(`Run pipeline on ${ids.length} ${filter === "all" && !query ? "" : "filtered "}domain(s)?`)) return
              setBusy("run-all")
              const r = await domainActions.runBulk(ids) as { ok?: boolean; message?: string; error?: string; count?: number }
              show(r.ok ? "ok" : "err", String(r.message ?? r.error ?? ""))
              setBusy(null); await refresh()
            }}
            disabled={busy === "run-all" || filtered.length === 0}
            title="Run the pipeline on every domain currently shown — respects search + status filters"
          >
            <Play className="h-3.5 w-3.5" /> Run all ({filtered.length})
          </Button>
          {/* Primary CTA — opens the multi-line Add Domains dialog */}
          <Button
            size="sm" className="gap-1.5 btn-info"
            onClick={openAddDialog}
            title="Add one or many domains — paste one per line, or comma-separated"
          >
            <Plus className="h-3.5 w-3.5" /> Add
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
        <span className="hidden">{isLoading ? 1 : 0}</span>
        {/* Status filter — coarse chips for the 7 buckets, plus a fine-grained
            22-status dropdown matching Flask's domains.html. Setting the
            dropdown overrides the chip filter; "All exact statuses" clears it. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {STATUS_FILTERS.map((f) => {
              const count =
                f.key === "all" ? DOMAINS.length : DOMAINS.filter((d) => d.status === f.key).length
              const active = !rawStatusFilter && filter === f.key
              return (
                <button
                  key={f.key}
                  onClick={() => { setRawStatusFilter(null); setFilter(f.key) }}
                  title={f.key === "all"
                    ? "Show every domain regardless of status"
                    : `Show only ${f.label.toLowerCase()} domains (coarse bucket — combines several raw statuses)`}
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
          <div className="ml-auto flex items-center gap-2">
            <Select
              value={rawStatusFilter ?? "__all__"}
              onValueChange={(v) => setRawStatusFilter(v === "__all__" ? null : v)}
            >
              <SelectTrigger size="sm" className="h-8 min-w-[200px] text-small">
                <SelectValue placeholder="Exact status — All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All exact statuses</SelectItem>
                {(["ok","in-flight","waiting","ready","error","other"] as const).map((g) => {
                  const items = RAW_STATUSES.filter((s) => s.group === g)
                  if (items.length === 0) return null
                  return (
                    <SelectGroup key={g}>
                      <SelectLabel>{RAW_STATUS_GROUPS[g]}</SelectLabel>
                      {items.map((s) => {
                        const n = DOMAINS.filter((d) => d.rawStatus === s.value).length
                        return (
                          <SelectItem key={s.value} value={s.value}>
                            <span className="font-mono text-micro">{s.value}</span>
                            <span className="ml-2 text-muted-foreground">{s.label}</span>
                            <span className="ml-auto pl-3 tabular-nums text-muted-foreground">{n}</span>
                          </SelectItem>
                        )
                      })}
                    </SelectGroup>
                  )
                })}
              </SelectContent>
            </Select>
            {rawStatusFilter && (
              <button
                onClick={() => setRawStatusFilter(null)}
                className="text-micro text-muted-foreground hover:text-foreground"
                aria-label="Clear exact-status filter"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <DataTableShell>
          <DataTableToolbar>
            <div className="relative flex-1 min-w-[260px] max-w-md">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
              <Textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search single (domain/email/IP), or paste comma/newline-separated list for exact-match"
                rows={1}
                className="min-h-[32px] max-h-[120px] pl-8 py-1.5 text-small font-mono resize-y"
              />
              {query.includes(",") || query.includes("\n") ? (
                <span className="absolute right-2 top-2 text-micro text-muted-foreground bg-card px-1.5 py-px rounded border border-border/60">
                  exact-match list mode
                </span>
              ) : null}
            </div>
            {(query || filter !== "all" || rawStatusFilter) && (
              <Button
                variant="outline" size="sm" className="gap-1.5"
                onClick={() => { setQuery(""); setFilter("all"); setRawStatusFilter(null) }}
                title="Clear search, status chip, and exact-status filter"
              >
                <X className="h-3.5 w-3.5" /> Clear filters
              </Button>
            )}
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
                <DataTableHeaderCell className="w-12 text-center">SSL</DataTableHeaderCell>
                <DataTableHeaderCell>Status</DataTableHeaderCell>
                <DataTableHeaderCell>Step</DataTableHeaderCell>
                <DataTableHeaderCell>Server</DataTableHeaderCell>
                <DataTableHeaderCell>CF key</DataTableHeaderCell>
                <DataTableHeaderCell>A-record</DataTableHeaderCell>
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
                      <a
                        href={`/domains/${encodeURIComponent(d.name)}`}
                        className="font-medium hover:underline underline-offset-2"
                        title={`Open detail page for ${d.name}`}
                      >
                        {d.name}
                      </a>
                      {d.registrar === "Imported" && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-micro font-medium text-muted-foreground">
                          imported
                        </span>
                      )}
                    </div>
                  </DataTableCell>
                  <DataTableCell className="text-center">
                    {/* SSL origin-cert lock icon. Updated by auto-heal sweep
                        every 5 min + by migration's ssl_verify step.
                          green closed lock = CF Origin Cert serving (verified)
                          red open lock     = wrong cert serving — clickable to
                                              enqueue a from-step-8 repair
                          spinner           = repair in flight (~30–120s)
                          gray lock         = never verified yet */}
                    {sslFixing.has(d.name) || sslChecking.has(d.name) ? (
                      <span
                        className="inline-block"
                        title={
                          sslFixing.has(d.name)
                            ? "SSL install/repair in progress — re-running pipeline from step 8 (install via SA API + verify)"
                            : "Re-probing origin cert…"
                        }
                      >
                        <Loader2 className="h-4 w-4 mx-auto animate-spin text-muted-foreground" aria-label="SSL probe in progress" />
                      </span>
                    ) : d.sslOk === true ? (
                      // Even when the wire-probe says "CF Origin Cert serving",
                      // SA's tracker can disagree (cert installed via SSH
                      // fallback bypassed SA's REST API → SA UI shows "Not
                      // Installed"). Click triggers a from-step-8 reinstall
                      // through SA's API path so the tracker reconciles.
                      // Shift-click does just a re-probe without reinstalling.
                      <button
                        type="button"
                        className="inline-flex items-center justify-center rounded-sm p-0.5 text-status-completed hover:bg-status-completed/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-status-completed"
                        title={`CloudFlare Origin Cert verified on origin${d.sslVerifiedAt ? ` at ${d.sslVerifiedAt}` : ""}. Click to reinstall via SA API (reconciles SA tracker if it shows "Not Installed"). Shift+click to re-probe only.`}
                        onClick={(e) => e.shiftKey ? recheckSsl(d.name) : fixSsl(d.name)}
                        aria-label={`Reinstall SSL for ${d.name}`}
                      >
                        <Lock className="h-4 w-4" />
                      </button>
                    ) : d.sslOk === false ? (
                      <button
                        type="button"
                        className="inline-flex items-center justify-center rounded-sm p-0.5 text-status-terminal hover:bg-status-terminal/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-status-terminal"
                        title={`Wrong / missing cert on origin${d.sslVerifiedAt ? ` (last checked ${d.sslVerifiedAt})` : ""}. Click to repair — re-runs pipeline from step 8.`}
                        onClick={() => fixSsl(d.name)}
                        aria-label={`Repair SSL for ${d.name}`}
                      >
                        <Unlock className="h-4 w-4" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="inline-flex items-center justify-center rounded-sm p-0.5 text-muted-foreground/60 hover:bg-status-warning/15 hover:text-status-warning focus:outline-none focus-visible:ring-1 focus-visible:ring-muted-foreground"
                        title="SSL never verified — pipeline hasn't reached step 8 yet. Click to install now (re-runs pipeline from step 8)."
                        onClick={() => fixSsl(d.name)}
                        aria-label={`Install SSL for ${d.name}`}
                      >
                        <Lock className="h-4 w-4 opacity-60" />
                      </button>
                    )}
                  </DataTableCell>
                  <DataTableCell>
                    <StatusBadge status={d.status} />
                  </DataTableCell>
                  <DataTableCell>
                    <span className="font-mono tabular-nums text-muted-foreground">{d.step}/10</span>
                  </DataTableCell>
                  <DataTableCell>
                    {(() => {
                      const s = d.serverId ? serversById[d.serverId] : undefined
                      if (!s) return <span className="text-muted-foreground">—</span>
                      return (
                        <div className="flex flex-col leading-tight">
                          <MonoCode>{s.ip}</MonoCode>
                          <span className="text-micro text-muted-foreground">
                            {s.name}{s.region ? ` · ${s.region}` : ""}
                          </span>
                        </div>
                      )
                    })()}
                  </DataTableCell>
                  <DataTableCell>
                    {(() => {
                      const k = d.cfKeyId ? cfKeysById[d.cfKeyId] : undefined
                      if (k) {
                        return (
                          <div className="flex flex-col leading-tight">
                            <span
                              className="rounded bg-muted px-1.5 py-0.5 text-micro font-medium text-foreground/80 w-fit"
                              title={`CF key pool entry #${k.id}`}
                            >
                              {k.alias || `CF#${k.id}`}
                            </span>
                            {d.cfEmail && (
                              <span className="text-micro text-muted-foreground mt-0.5">{d.cfEmail}</span>
                            )}
                          </div>
                        )
                      }
                      if (d.cfEmail) {
                        return (
                          <div className="flex flex-col leading-tight">
                            <span className="text-micro text-muted-foreground">{d.cfEmail}</span>
                            <span className="text-micro text-muted-foreground/70">(no pool key)</span>
                          </div>
                        )
                      }
                      return <span className="text-muted-foreground">—</span>
                    })()}
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
                        variant="ghost" size="icon"
                        className="h-7 w-7 text-[color:var(--success)] hover:bg-[color:color-mix(in_oklch,var(--success)_14%,transparent)] hover:text-[color:var(--success)]"
                        aria-label="Run pipeline"
                        title={`Run pipeline for ${d.name} — opens the start dialog (skip-purchase, server, preflight)`}
                        disabled={busy === d.name}
                        onClick={() => openRunModal(d.name)}
                      >
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                      <a href={`/watcher?domain=${encodeURIComponent(d.name)}`} title={`Watch live step progress for ${d.name}`}>
                        <Button
                          variant="ghost" size="icon"
                          className="h-7 w-7 text-[color:var(--info)] hover:bg-[color:color-mix(in_oklch,var(--info)_14%,transparent)] hover:text-[color:var(--info)]"
                          aria-label="Watch steps"
                          title={`Watch live step progress for ${d.name}`}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      </a>
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7"
                        aria-label="Run history"
                        title={`Run history for ${d.name} — view past runs, retry/skip/override per step`}
                        onClick={() => openHistoryModal(d.name)}
                      >
                        <History className="h-3.5 w-3.5" />
                      </Button>
                      <ButtonGroupSeparator />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost" size="icon" className="h-7 w-7"
                            aria-label="More actions" title="More actions — Cancel · Check NS · CF credentials · Delete"
                          >
                            <ChevronDown className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem onClick={() => cancelOne(d.name)}>
                            <Ban className="mr-2 h-3.5 w-3.5" /> Cancel pipeline
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={async () => {
                            const r = await domainActions.checkNs(d.name)
                            show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
                          }}>
                            <Filter className="mr-2 h-3.5 w-3.5" /> Check NS
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openCfModal(d.name)}>
                            <Upload className="mr-2 h-3.5 w-3.5" /> CF credentials
                          </DropdownMenuItem>
                          {(() => {
                            const sIp = (d.serverId ? serversById[d.serverId]?.ip : null) || (d.ip !== "—" ? d.ip : null)
                            return (
                              <DropdownMenuItem
                                disabled={!sIp}
                                onClick={() => sIp && openFiles(d.name, sIp)}
                              >
                                <FileUp className="mr-2 h-3.5 w-3.5" /> Files
                              </DropdownMenuItem>
                            )
                          })()}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => softDeleteOne(d.name)}>
                            <Archive className="mr-2 h-3.5 w-3.5" /> Soft delete
                          </DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onClick={() => hardDeleteOne(d.name)}>
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

        {/* Bulk action bar — gains Flask's Skip-purchase + Server picker so a
            bulk run can be aimed at one specific server (or auto round-robin). */}
        {selected.size > 0 && (
          <div
            role="toolbar"
            aria-label="Bulk actions"
            className="sticky bottom-4 mx-auto flex w-full max-w-4xl flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-lg"
          >
            <button
              onClick={() => setSelected(new Set())}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Clear selection" title="Clear selection"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <span className="text-[13px] font-medium">
              {selected.size} {selected.size === 1 ? "domain" : "domains"} selected
            </span>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />

            <label
              className="inline-flex items-center gap-1.5 text-small"
              title="Skip Spaceship purchase in step 1 — assume each domain is already owned (BYO)"
            >
              <Checkbox
                checked={bulkSkipPurchase}
                onCheckedChange={(v) => setBulkSkipPurchase(Boolean(v))}
              />
              Skip purchase
            </label>
            <Select value={bulkServerId || "__auto__"} onValueChange={(v) => setBulkServerId(v === "__auto__" ? "" : v)}>
              <SelectTrigger size="sm" className="h-8 min-w-[180px] text-small"
                title="Pin all selected runs to one server, or leave on Auto for round-robin">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__auto__">Auto server (round-robin)</SelectItem>
                <SelectItem value="__new__">Provision new server (fresh DO droplet)</SelectItem>
                {eligibleServers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} ({s.ip}) · {s.domains}/{s.capacity}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={bulkCustomProvider || "__default__"}
              onValueChange={(v) => setBulkCustomProvider(v === "__default__" ? "" : v)}
            >
              <SelectTrigger
                size="sm" className="h-8 min-w-[180px] text-small"
                title="Override the default LLM provider for step 9 across this entire batch — useful when the default key is rate-limited"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">LLM: default (from Settings)</SelectItem>
                <SelectItem value="anthropic">LLM: Anthropic (Claude)</SelectItem>
                <SelectItem value="openai">LLM: OpenAI (GPT)</SelectItem>
                <SelectItem value="gemini">LLM: Google Gemini</SelectItem>
                <SelectItem value="openrouter">LLM: OpenRouter</SelectItem>
                <SelectItem value="moonshot">LLM: Moonshot Kimi</SelectItem>
                <SelectItem value="cloudflare">LLM: Cloudflare Workers AI</SelectItem>
                <SelectItem value="cloudflare_pool">LLM: Cloudflare Workers AI POOL</SelectItem>
              </SelectContent>
            </Select>
            <div className="w-[220px]" title="Override the model id for step 9 across this batch. Empty = provider default.">
              <ModelPicker
                provider={bulkCustomProvider || "anthropic"}
                value={bulkCustomModel}
                onChange={setBulkCustomModel}
                size="sm"
              />
            </div>

            <ButtonGroup>
              <Button
                size="sm" variant="outline"
                className="gap-1.5 btn-soft-success"
                onClick={bulkRun} disabled={busy === "bulk"}
                title="PARALLEL — runs up to SSR_JOB_WORKERS pipelines at the same time. Fastest. Honors Skip-purchase + Server above."
              >
                <Play className="h-3.5 w-3.5" /> Run all (parallel)
              </Button>
              <Button
                size="sm" variant="outline"
                className="gap-1.5 btn-soft-success"
                onClick={bulkRunSequential} disabled={busy === "bulk"}
                title="SEQUENTIAL — pipelines run ONE BY ONE in a single worker. Each domain starts only after the previous finishes. Smaller external-API blast radius; total wall-time is the sum of each pipeline. Good for small batches (5–10) or when you want predictable ordering."
              >
                <Play className="h-3.5 w-3.5" /> Run one-by-one
              </Button>
              <Button
                size="sm" variant="outline"
                className="gap-1.5 btn-soft-info"
                onClick={openBulkMigrate} disabled={busy === "bulk"}
                title="Move selected domains to a different server — old SA app removed, new one created on target, CF A-records flipped, original NS/zone preserved"
              >
                <ArrowLeftRight className="h-3.5 w-3.5" /> Migrate to server
              </Button>
              <Button
                size="sm" variant="outline"
                className="gap-1.5 btn-soft-warning"
                onClick={bulkCancel} disabled={busy === "bulk"}
                title="Request graceful cancel on every selected running pipeline"
              >
                <Ban className="h-3.5 w-3.5" /> Cancel
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm" variant="outline"
                    className="gap-1.5 btn-soft-destructive"
                    disabled={busy === "bulk"}
                    title="Delete the selected domains — pick dashboard-only or full teardown"
                  >
                    <Archive className="h-3.5 w-3.5" /> Delete… <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuLabel>Delete mode</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={bulkSoftDelete}>
                    <Archive className="mr-2 h-3.5 w-3.5" />
                    <div className="flex flex-col">
                      <span>Dashboard only</span>
                      <span className="text-micro text-muted-foreground">Drops rows · keeps SA + CF zone + Spaceship</span>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={bulkHardDelete}>
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    <div className="flex flex-col">
                      <span>Full delete — one by one</span>
                      <span className="text-micro">Sequential · ~10–15 s per domain · safest</span>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={bulkHardDeleteParallel}>
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    <div className="flex flex-col">
                      <span>Full delete — parallel</span>
                      <span className="text-micro">Up to SSR_JOB_WORKERS at once · ~Nx faster · semaphored</span>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </ButtonGroup>
          </div>
        )}
      </div>

      {/* === Pipeline Run modal — replaces Flask's #pipelineModal === */}
      <OperatorDialog
        open={runModalDomain !== null}
        onOpenChange={(o) => { if (!o) setRunModalDomain(null) }}
        title={`Run pipeline — ${runModalDomain ?? ""}`}
        description="Smart resume: the worker auto-detects completed steps. Override with Start From if you want to force a specific step."
        submitLabel="Start"
        onSubmit={submitRunPipeline}
        resultMessage={runResult?.text ?? null}
        resultKind={runResult?.kind ?? null}
      >
        <Field>
          <FieldLabel>
            <span className="inline-flex items-center gap-2">
              <Checkbox
                checked={runOpts.skipPurchase}
                onCheckedChange={(v) => setRunOpts((o) => ({ ...o, skipPurchase: Boolean(v) }))}
              />
              Skip purchase (BYO domain)
            </span>
          </FieldLabel>
          <FieldDescription>Skips Spaceship purchase in step 1; assumes you already own the domain.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Start from step</FieldLabel>
          <Select
            value={runOpts.startFrom || "__auto__"}
            onValueChange={(v) => setRunOpts((o) => ({ ...o, startFrom: v === "__auto__" ? "" : v }))}
          >
            <SelectTrigger size="sm" className="h-8 text-small"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__auto__">Auto-detect (recommended)</SelectItem>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} — {PIPELINE_STEPS[n]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>Server</FieldLabel>
          <Select
            value={runOpts.serverId || "__auto__"}
            onValueChange={(v) => setRunOpts((o) => ({ ...o, serverId: v === "__auto__" ? "" : v }))}
          >
            <SelectTrigger size="sm" className="h-8 text-small"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__auto__">Auto (round-robin across ready servers)</SelectItem>
              <SelectItem value="__new__">Provision new server (fresh DO droplet)</SelectItem>
              {eligibleServers.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name} ({s.ip}) · {s.domains}/{s.capacity}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>Step 9 LLM override</FieldLabel>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Select
              value={runOpts.customProvider || "__default__"}
              onValueChange={(v) => setRunOpts((o) => ({ ...o, customProvider: v === "__default__" ? "" : v }))}
            >
              <SelectTrigger size="sm" className="h-8 text-small"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">(use default from Settings)</SelectItem>
                <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                <SelectItem value="openai">OpenAI (GPT)</SelectItem>
                <SelectItem value="gemini">Google Gemini</SelectItem>
                <SelectItem value="openrouter">OpenRouter</SelectItem>
                <SelectItem value="moonshot">Moonshot Kimi</SelectItem>
                <SelectItem value="cloudflare">Cloudflare Workers AI (single)</SelectItem>
                <SelectItem value="cloudflare_pool">Cloudflare Workers AI POOL</SelectItem>
              </SelectContent>
            </Select>
            <ModelPicker
              provider={runOpts.customProvider || "anthropic"}
              value={runOpts.customModel}
              onChange={(v) => setRunOpts((o) => ({ ...o, customModel: v }))}
              size="sm"
            />
          </div>
          <FieldDescription>
            Routes step 9 to a different LLM than the default for this run only — useful when your
            primary key is rate-limited. Empty model = provider default.
          </FieldDescription>
        </Field>
        <div className="rounded-md border border-border/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[13px] font-medium">Preflight</div>
              <p className="text-micro text-muted-foreground mt-0.5">
                Run the 7 preflight checks (CF pool, DO token, SA auth, etc.) before kicking off.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={runPreflight}>Run preflight</Button>
          </div>
          {preflightResult && (
            <ul className="mt-2 flex flex-col gap-1 text-micro font-mono">
              {Object.entries(preflightResult.checks).map(([name, c]) => (
                <li key={name} className={c.ok ? "text-status-completed" : "text-status-terminal"}>
                  {c.ok ? "✓" : "✗"} {name}: {c.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </OperatorDialog>

      {/* === Run History modal — list /api/domains/[domain]/runs + drill into /api/runs/[id] === */}
      <OperatorDialog
        open={historyDomain !== null}
        onOpenChange={(o) => { if (!o) { setHistoryDomain(null); setHistoryDetail(null) } }}
        title={`Run history — ${historyDomain ?? ""}`}
        submitLabel="Close"
        onSubmit={() => { setHistoryDomain(null); setHistoryDetail(null) }}
      >
        {!historyDetail ? (
          <div className="flex flex-col gap-1.5 max-h-[60vh] overflow-y-auto">
            {historyRuns === null && <span className="text-muted-foreground text-micro">Loading…</span>}
            {historyRuns?.length === 0 && (
              <span className="text-muted-foreground text-micro">No runs yet for this domain.</span>
            )}
            {historyRuns?.map((r) => {
              const start = r.started_at ? new Date(r.started_at * 1000).toLocaleString() : "—"
              const dur = r.started_at && r.ended_at ? `${Math.round(r.ended_at - r.started_at)}s` : "running"
              const isRunning = r.status === "running"
              return (
                <div
                  key={r.id}
                  className="rounded border border-border/60 p-2 hover:bg-muted text-small"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <button
                        onClick={() => openRunDetail(r.id)}
                        className="text-left font-mono"
                        title="Open per-step detail for this run inline"
                      >
                        run #{r.id}
                      </button>
                      <a
                        href={`/watcher/${r.id}`}
                        target="_blank" rel="noopener noreferrer"
                        className="text-micro text-muted-foreground hover:text-foreground"
                        title="Open this run on its own page (bookmarkable, shareable)"
                        onClick={(e) => e.stopPropagation()}
                      >
                        ↗
                      </a>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        "text-micro font-medium",
                        r.status === "completed" && "text-status-completed",
                        r.status === "failed" && "text-status-terminal",
                        r.status === "waiting" && "text-status-waiting",
                        r.status === "running" && "text-status-running",
                      )}>
                        {r.status}
                      </span>
                      {isRunning && historyDomain && (
                        <Button
                          variant="outline" size="sm" className="h-6 gap-1 btn-soft-warning"
                          onClick={async (e) => {
                            e.stopPropagation()
                            if (!confirm(
                              `Cancel running pipeline for ${historyDomain}?\n\n` +
                              `Cancel is GRACEFUL — the worker checks the cancel flag at each step boundary, ` +
                              `so a long step (e.g., the 5–15 min SA agent install during step 6) finishes ` +
                              `before the cancel takes effect.`,
                            )) return
                            const res = await domainActions.cancelPipeline(historyDomain)
                            show(res.ok ? "ok" : "err", res.message ?? res.error ?? "Cancel requested")
                          }}
                          title="Cancel this running pipeline (graceful — stops at next step boundary)"
                        >
                          <StopCircle className="h-3 w-3" /> Stop
                        </Button>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => openRunDetail(r.id)}
                    className="text-left text-micro text-muted-foreground mt-0.5 block"
                  >
                    {start} · {dur}
                    {r.error && <span className="text-status-terminal"> · {r.error}</span>}
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <div className="text-small font-mono">run #{historyDetail.runId}</div>
              <button onClick={() => setHistoryDetail(null)} className="text-micro text-muted-foreground hover:text-foreground">
                ← back to list
              </button>
            </div>
            <ol className="flex flex-col gap-1.5">
              {historyDetail.steps.map((s) => {
                const dur = s.started_at && s.ended_at ? `${Math.round(s.ended_at - s.started_at)}s` : "—"
                return (
                  <li key={s.step_num} className="rounded border border-border/60 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-micro">
                        {s.step_num}. {PIPELINE_STEPS[s.step_num]}
                      </span>
                      <span className={cn(
                        "text-micro font-medium",
                        s.status === "completed" && "text-status-completed",
                        s.status === "failed" && "text-status-terminal",
                        s.status === "warning" && "text-status-waiting",
                        s.status === "running" && "text-status-running",
                      )}>{s.status} · {dur}</span>
                    </div>
                    {s.message && <div className="text-micro text-muted-foreground mt-1 break-words">{s.message}</div>}
                    {s.artifact_json && (
                      <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted p-1.5 text-[10px] leading-tight">
                        {s.artifact_json}
                      </pre>
                    )}
                    {historyDomain && (s.status === "failed" || s.status === "warning" || s.status === "completed") && (
                      <div className="mt-1.5 flex gap-1.5 flex-wrap">
                        {(s.status === "failed" || s.status === "warning") && (
                          <Button
                            variant="outline" size="sm" className="h-7 gap-1"
                            onClick={() => retryFromStep(historyDomain, s.step_num)}
                            title={`Re-run pipeline starting at step ${s.step_num}`}
                          >
                            <Play className="h-3 w-3" /> Retry from {s.step_num}
                          </Button>
                        )}
                        <Button
                          variant="outline" size="sm" className="h-7 gap-1"
                          disabled={s.step_num >= 10}
                          onClick={() => retryFromStep(historyDomain, s.step_num + 1)}
                          title={s.step_num >= 10 ? "Already at the last step" : `Skip step ${s.step_num} — start at step ${s.step_num + 1}`}
                        >
                          Skip → {s.step_num + 1}
                        </Button>
                        <Button
                          variant="outline" size="sm" className="h-7 gap-1"
                          onClick={() => {
                            // Per-step field hint (Flask parity) so the operator
                            // doesn't have to remember which DB column each
                            // pipeline step writes to. Falls back to site_html.
                            const FIELD_HINT: Record<number, string> = {
                              1: "status",
                              2: "cf_email",
                              3: "cf_zone_id",
                              4: "cf_nameservers",
                              7: "current_proxy_ip",
                              8: "origin_cert_pem",
                              9: "site_html",
                            }
                            const hint = FIELD_HINT[s.step_num] ?? "site_html"
                            const field = window.prompt(
                              `Override which field for ${historyDomain}?\n\n` +
                              `Allowed: site_html, status, cf_zone_id, cf_nameservers, ` +
                              `cf_email, cf_global_key, current_proxy_ip, origin_cert_pem, origin_key_pem`,
                              hint,
                            )?.trim()
                            if (!field) return
                            const value = window.prompt(`New value for ${field}:`) ?? ""
                            void domainActions.override(historyDomain, field, value).then((r) => {
                              show(r.ok ? "ok" : "err", r.message ?? r.error ?? "")
                              setHistoryDomain(null)
                            })
                          }}
                          title={`Manually override one whitelisted domain column (step ${s.step_num} suggests its primary field)`}
                        >
                          Override field
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          </div>
        )}
      </OperatorDialog>

      {/* === CF Credentials modal — replaces Flask's #cfModal === */}
      <OperatorDialog
        open={cfModalDomain !== null}
        onOpenChange={(o) => { if (!o) { setCfModalDomain(null); setCfShowKey(false) } }}
        title={`CF credentials — ${cfModalDomain ?? ""}`}
        description="Manual override. Fields you leave blank stay unchanged. Normally these are populated by the CF key pool — only edit when something is broken."
        submitLabel="Save"
        onSubmit={submitCfUpdate}
        resultMessage={cfResult?.text ?? null}
        resultKind={cfResult?.kind ?? null}
      >
        <Field>
          <FieldLabel>cf_email</FieldLabel>
          <Input
            type="email"
            value={cfFields.email}
            onChange={(e) => setCfFields((s) => ({ ...s, email: e.target.value }))}
            placeholder="(leave blank to keep)"
          />
        </Field>
        <Field>
          <FieldLabel>cf_global_key</FieldLabel>
          <div className="relative">
            <Input
              type={cfShowKey ? "text" : "password"}
              value={cfFields.key}
              onChange={(e) => setCfFields((s) => ({ ...s, key: e.target.value }))}
              className="pr-9 font-mono text-small"
              placeholder="(leave blank to keep)"
            />
            <button
              type="button"
              onClick={() => setCfShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={cfShowKey ? "Hide API key" : "Show API key"}
              title={cfShowKey ? "Hide API key" : "Show API key"}
              tabIndex={-1}
            >
              {cfShowKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        </Field>
        <Field>
          <FieldLabel>cf_zone_id</FieldLabel>
          <Input
            value={cfFields.zone}
            onChange={(e) => setCfFields((s) => ({ ...s, zone: e.target.value }))}
            placeholder="(leave blank to keep)"
            className="font-mono text-small"
          />
        </Field>
      </OperatorDialog>

      {/* === Bulk migrate to server modal === */}
      <OperatorDialog
        open={migrateOpen}
        onOpenChange={(o) => { if (!o) setMigrateOpen(false) }}
        title={`Migrate ${selected.size} domain(s) to a server`}
        description="Each selected domain's SA app moves to the chosen target — old app removed, new one created, CF A-records flipped to the new IP. Original CF zone, nameservers, and registrar settings are preserved."
        submitLabel="Start migration"
        onSubmit={submitBulkMigrate}
        resultMessage={migrateResult?.text ?? null}
        resultKind={migrateResult?.kind ?? null}
      >
        <Field>
          <FieldLabel>Target server</FieldLabel>
          <Select value={migrateTarget} onValueChange={setMigrateTarget}>
            <SelectTrigger size="sm" className="h-8 text-small"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__auto__">Auto — lowest-utilization eligible server (excluding source)</SelectItem>
              <SelectItem value="__new__">Provision new server (fresh DO droplet, 5–15 min)</SelectItem>
              {eligibleServers.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name} ({s.ip}) · {s.domains}/{s.capacity}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            Migration uses the cached site archive at <code className="font-mono">data/site_archives/&lt;domain&gt;.tar.gz</code> —
            no LLM regeneration; same content reuploads to the new server. Existing Origin CA cert is also reused.
          </FieldDescription>
        </Field>
      </OperatorDialog>

      {/* === Add Domains modal — replaces window.prompt chain === */}
      <OperatorDialog
        open={addOpen}
        onOpenChange={(o) => { if (!o) setAddOpen(false) }}
        title="Add Domains"
        description="Paste one per line, or comma-separated. Each row inserts as status=pending — the pipeline will run only if you trigger it from the row Run action."
        submitLabel="Add"
        onSubmit={submitAdd}
        resultMessage={addResult?.text ?? null}
        resultKind={addResult?.kind ?? null}
      >
        <Field>
          <FieldLabel>Domains</FieldLabel>
          <Textarea
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            rows={8}
            className="font-mono text-small"
            placeholder={"example1.com\nexample2.site\nexample3.net"}
            autoFocus
          />
          <FieldDescription>Invalid lines are silently skipped — the response shows added/skipped counts.</FieldDescription>
        </Field>
      </OperatorDialog>

      {/* === Import CSV modal — replaces silent file picker === */}
      <OperatorDialog
        open={importOpen}
        onOpenChange={(o) => { if (!o) setImportOpen(false) }}
        title="Import Domains from CSV"
        description="Bulk-add domains; optionally restore CF credentials in the same shot."
        submitLabel="Import"
        onSubmit={submitImport}
        resultMessage={importResult?.text ?? null}
        resultKind={importResult?.kind ?? null}
      >
        <div className="rounded-md border border-status-running/30 bg-status-running/8 px-3 py-2 text-small text-status-running flex items-start gap-2">
          <Info className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
          <div>
            CSV must have a <code className="font-mono">domain</code> column. Optional columns:{" "}
            <code className="font-mono">cf_email</code>,{" "}
            <code className="font-mono">cf_global_key</code>,{" "}
            <code className="font-mono">cf_zone_id</code>,{" "}
            <code className="font-mono">cf_nameservers</code> — to restore credentials when re-importing.
          </div>
        </div>
        <Field>
          <FieldLabel>CSV File</FieldLabel>
          <label className="flex items-center gap-2 cursor-pointer rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 hover:bg-muted/50 text-small">
            <FileUp className="h-4 w-4 text-muted-foreground" aria-hidden />
            <span className="text-muted-foreground">
              {importFile ? importFile.name : "Click to choose a .csv file"}
            </span>
            <input
              type="file" accept=".csv,text/csv" className="hidden"
              onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
            />
            {importFile && (
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); setImportFile(null) }}
                className="ml-auto text-micro text-muted-foreground hover:text-foreground"
                title="Clear chosen file"
              >
                clear
              </button>
            )}
          </label>
        </Field>
      </OperatorDialog>

      <FileBrowserDialog
        open={!!filesDomain && !!filesServerIp}
        onOpenChange={(o) => { if (!o) { setFilesDomain(""); setFilesServerIp("") } }}
        domain={filesDomain}
        serverIp={filesServerIp}
      />
    </AppShell>
  )
}
