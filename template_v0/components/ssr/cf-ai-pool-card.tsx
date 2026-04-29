"use client"

import * as React from "react"
import useSWR from "swr"
import {
  Plus, Loader2, Check, X, Trash2, AlertTriangle, Sparkles,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter, DialogTrigger,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

interface CfAiKeyRow {
  id: number
  account_id: string
  alias: string | null
  is_active: number
  calls_today: number
  calls_total: number
  last_call_at: string | null
  last_error: string | null
  created_at: string
  account_id_preview: string
  token_preview: string
}

interface PoolResponse {
  cf_ai_keys: CfAiKeyRow[]
  summary: {
    active: number
    daily_neuron_budget: number
  }
}

const fetcher = async (url: string): Promise<PoolResponse> => {
  const r = await fetch(url, { credentials: "same-origin" })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/** Format a "x ago" string from an ISO datetime; null → "never". */
function relativeAgo(iso: string | null): string {
  if (!iso) return "never"
  const t = Date.parse(iso.endsWith("Z") ? iso : `${iso.replace(" ", "T")}Z`)
  if (!Number.isFinite(t)) return iso
  const seconds = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function CfAiPoolCard() {
  const { data, mutate, isLoading } = useSWR<PoolResponse>(
    "/api/cf-ai-keys", fetcher, { revalidateOnFocus: false, refreshInterval: 30_000 },
  )
  const rows = data?.cf_ai_keys ?? []
  const active = data?.summary.active ?? 0
  const budget = data?.summary.daily_neuron_budget ?? 0

  return (
    <div className="rounded-md border border-border/60 bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="h-3.5 w-3.5 text-status-completed" />
          <span className="text-[13px] font-semibold">Cloudflare Workers AI pool</span>
          <span className="rounded bg-status-completed/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-status-completed">
            free tier · K2.6
          </span>
        </div>
        <AddPoolKeyDialog onAdded={() => void mutate()} />
      </div>

      <div className="px-3 py-2 text-micro text-muted-foreground">
        {isLoading ? (
          <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</span>
        ) : rows.length === 0 ? (
          <span>
            Pool is empty. Add a (account ID, Workers AI token) pair to start stacking the
            free 10 000-neuron/day quota across multiple Cloudflare accounts.
          </span>
        ) : (
          <span>
            <strong className="text-foreground">{active}</strong> active row(s) · stacked daily budget ≈{" "}
            <strong className="text-foreground">{budget.toLocaleString()}</strong> neurons
            (~{Math.round(budget / 250).toLocaleString()} K2.6 calls/day est.)
          </span>
        )}
      </div>

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-small">
            <thead className="border-y border-border/60 bg-muted/40 text-micro uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Alias / account</th>
                <th className="px-3 py-1.5 text-left font-medium">Token</th>
                <th className="px-3 py-1.5 text-right font-medium" title="Calls today (resets at UTC midnight)">Today</th>
                <th className="px-3 py-1.5 text-right font-medium" title="Lifetime calls">Total</th>
                <th className="px-3 py-1.5 text-left font-medium">Last call</th>
                <th className="px-3 py-1.5 text-center font-medium">Active</th>
                <th className="px-3 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <PoolRow key={r.id} row={r} onChange={() => void mutate()} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function PoolRow({ row, onChange }: { row: CfAiKeyRow; onChange: () => void }) {
  const [busy, setBusy] = React.useState(false)
  async function patch(action: "toggle" | "edit", body: object = {}): Promise<void> {
    setBusy(true)
    try {
      await fetch(`/api/cf-ai-keys/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action, ...body }),
      })
      onChange()
    } finally {
      setBusy(false)
    }
  }
  async function remove(): Promise<void> {
    if (!confirm(`Remove pool row #${row.id} (${row.alias ?? row.account_id_preview}) from the Workers AI pool?`)) return
    setBusy(true)
    try {
      await fetch(`/api/cf-ai-keys/${row.id}`, { method: "DELETE", credentials: "same-origin" })
      onChange()
    } finally {
      setBusy(false)
    }
  }
  return (
    <tr className={cn("border-b border-border/40 last:border-0", !row.is_active && "opacity-60")}>
      <td className="px-3 py-2">
        <div className="font-medium">{row.alias ?? <span className="text-muted-foreground italic">(no alias)</span>}</div>
        <div className="font-mono text-micro text-muted-foreground">{row.account_id_preview}</div>
      </td>
      <td className="px-3 py-2 font-mono text-micro text-muted-foreground">{row.token_preview}</td>
      <td className="px-3 py-2 text-right tabular-nums">{row.calls_today}</td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{row.calls_total}</td>
      <td className="px-3 py-2 text-micro">
        <span className="text-muted-foreground">{relativeAgo(row.last_call_at)}</span>
        {row.last_error && (
          <div
            className="mt-0.5 inline-flex max-w-[260px] items-center gap-1 truncate text-status-terminal"
            title={row.last_error}
          >
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="truncate">{row.last_error}</span>
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-center">
        <Switch
          checked={Boolean(row.is_active)}
          onCheckedChange={() => void patch("toggle")}
          disabled={busy}
          aria-label={row.is_active ? "Deactivate pool row" : "Activate pool row"}
          title={row.is_active ? "Deactivate (skip in rotation)" : "Activate (include in rotation)"}
        />
      </td>
      <td className="px-3 py-2 text-right">
        <Button
          type="button" variant="ghost" size="sm"
          className="text-status-terminal hover:bg-status-terminal/10"
          onClick={remove} disabled={busy}
          title={`Remove pool row #${row.id}`}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </Button>
      </td>
    </tr>
  )
}

function AddPoolKeyDialog({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [accountId, setAccountId] = React.useState("")
  const [apiToken, setApiToken] = React.useState("")
  const [alias, setAlias] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)

  function reset(): void {
    setAccountId(""); setApiToken(""); setAlias(""); setErr(null)
  }

  async function submit(): Promise<void> {
    if (!accountId.trim() || !apiToken.trim()) {
      setErr("Both account ID and API token are required"); return
    }
    setBusy(true); setErr(null)
    try {
      const fd = new FormData()
      fd.set("account_id", accountId.trim())
      fd.set("api_token", apiToken.trim())
      if (alias.trim()) fd.set("alias", alias.trim())
      const r = await fetch("/api/cf-ai-keys/add", {
        method: "POST", body: fd, credentials: "same-origin",
      })
      const j = (await r.json()) as { ok?: boolean; error?: string }
      if (!j.ok) {
        setErr(j.error ?? `HTTP ${r.status}`)
        return
      }
      reset(); setOpen(false); onAdded()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset() }}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" className="btn-soft-success gap-1.5" title="Add a CF account to the Workers AI pool">
          <Plus className="h-3.5 w-3.5" /> Add pool row
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Add Cloudflare Workers AI pool row</DialogTitle>
          <DialogDescription>
            Each row contributes one CF account&apos;s 10 000-neuron/day free tier
            (~30–50 K2.6 calls/day per row). Token must have the Workers AI Read
            scope on the named account — we live-verify before insert.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-micro font-medium">Account ID</label>
            <Input
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="32-character hex from dash.cloudflare.com"
              className="font-mono text-small mt-1"
              autoFocus
            />
          </div>
          <div>
            <label className="text-micro font-medium">Workers AI API token</label>
            <Input
              type="password"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              placeholder="scope = Workers AI Read"
              className="font-mono text-small mt-1"
            />
          </div>
          <div>
            <label className="text-micro font-medium">Alias <span className="text-muted-foreground">(optional)</span></label>
            <Input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="e.g. cf-ai-1, alpha, main-account…"
              className="text-small mt-1"
            />
          </div>
          {err && (
            <div className="rounded-md border border-status-terminal/30 bg-status-terminal/5 px-3 py-2 text-micro text-status-terminal flex items-start gap-2">
              <X className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{err}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" size="sm" className="btn-soft-success gap-1.5" onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Verify &amp; add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
