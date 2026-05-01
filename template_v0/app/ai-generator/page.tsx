"use client"

import * as React from "react"
import useSWR from "swr"
import {
  Sparkles, Play, Loader2, ListChecks, FileText, ExternalLink, Plus, RotateCw,
} from "lucide-react"
import { AppShell } from "@/components/ssr/app-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { ModelPicker } from "@/components/ssr/model-picker"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MasterPromptCard } from "@/components/ssr/master-prompt-card"
import { cn } from "@/lib/utils"

interface QueueRow {
  domain: string
  status: string
  step: number | null
  step_message?: string | null
}

interface StepTrackerRow {
  domain: string
  step_num: number
  step_name: string
  status: string
  message: string
  started_at: string | null
  finished_at: string | null
}

const fetcher = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url, { credentials: "same-origin" })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json() as Promise<T>
}

/**
 * AI Site Generator — focused operator UI for queueing one-or-many domains
 * through the full pipeline (LLM gen → upload → DNS → SSL). Reuses the
 * existing pipeline; this page is a friendlier surface than /domains for
 * the common AI-gen workflow.
 */
export default function AiGeneratorPage() {
  const [single, setSingle] = React.useState("")
  const [bulk, setBulk] = React.useState("")
  const [skipPurchase, setSkipPurchase] = React.useState(true)
  const [provider, setProvider] = React.useState("")
  const [model, setModel] = React.useState("")
  const [brief, setBrief] = React.useState("")
  const [busy, setBusy] = React.useState<"single" | "bulk" | "regen" | null>(null)
  const [flash, setFlash] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)
  const [showPrompt, setShowPrompt] = React.useState(false)
  const [recent, setRecent] = React.useState<string[]>([])
  // Selected hosted domains for the "Regenerate existing site" flow.
  const [regenSelected, setRegenSelected] = React.useState<Set<string>>(new Set())

  function show(kind: "ok" | "err", text: string): void {
    setFlash({ kind, text })
    window.setTimeout(() => setFlash(null), 7000)
  }

  // Live queue — derive from /api/watcher (step_tracker grouped by domain)
  // + /api/domains (overall domain status) + the `recent` list (so just-
  // submitted rows show immediately even before the pipeline ticks).
  const { data: watcher, mutate: mutateWatcher } = useSWR<{
    watchers: Record<string, StepTrackerRow[]>
    active_domains: string[]
  }>("/api/watcher", fetcher, { refreshInterval: 4000, revalidateOnFocus: false })
  // /api/domains returns `{ domains: [...] }` (not `{ rows: ... }` — that
  // shape was a typo here that left the queue's status badge always
  // falling back to the watcher's last-seen step).
  const { data: domainsResp } = useSWR<{
    domains: { domain: string; status: string }[]
  }>(
    "/api/domains", fetcher,
    { refreshInterval: 6000, revalidateOnFocus: false },
  )
  const queueRows = React.useMemo<QueueRow[]>(() => {
    const dmap = new Map((domainsResp?.domains ?? []).map((d) => [d.domain, d.status]))
    const wmap = watcher?.watchers ?? {}
    const out: QueueRow[] = []
    for (const d of recent) {
      const steps = wmap[d] ?? []
      // Pick the highest step that's running; else the last failed/warning;
      // else the last completed; else nothing.
      const running = steps.find((s) => s.status === "running")
      const failed = [...steps].reverse().find((s) => s.status === "failed" || s.status === "warning")
      const lastDone = [...steps].reverse().find((s) => s.status === "completed" || s.status === "skipped")
      const cur = running ?? failed ?? lastDone
      const status = dmap.get(d) ?? (cur?.status ?? "queued")
      out.push({
        domain: d,
        status,
        step: cur?.step_num ?? null,
        step_message: cur?.message ?? null,
      })
    }
    return out
  }, [recent, watcher, domainsResp])

  function parseDomains(text: string): string[] {
    return text
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean)
      .map((d) => d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, ""))
      .filter((d, i, a) => a.indexOf(d) === i)
  }

  async function submit(domains: string[]): Promise<void> {
    if (domains.length === 0) {
      show("err", "Enter a domain first")
      return
    }
    const r = await fetch("/api/ai-generator/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        domains,
        skip_purchase: skipPurchase,
        custom_provider: provider || undefined,
        custom_model: model || undefined,
        custom_prompt: brief || undefined,
      }),
    })
    const j = (await r.json()) as {
      ok?: boolean; message?: string; error?: string
      enqueued?: string[]; warning?: string
    }
    if (!j.ok) {
      show("err", j.error ?? "Queue failed")
      return
    }
    show("ok", j.message + (j.warning ? ` · ${j.warning}` : ""))
    setRecent((prev) => [...new Set([...(j.enqueued ?? []), ...prev])].slice(0, 100))
    await mutateWatcher()
  }

  async function submitSingle(): Promise<void> {
    setBusy("single")
    try {
      await submit(parseDomains(single))
      setSingle("")
    } finally {
      setBusy(null)
    }
  }
  async function submitBulk(): Promise<void> {
    const domains = parseDomains(bulk)
    if (domains.length === 0) { show("err", "Paste at least one domain"); return }
    if (!confirm(
      `Queue ${domains.length} domain(s) for AI site generation?\n\n` +
      `They'll process ONE AT A TIME (sequential bulk). Each goes through ` +
      `the full pipeline: domain row → CF zone → DNS → SSL → LLM site → upload.`,
    )) return
    setBusy("bulk")
    try {
      await submit(domains)
      setBulk("")
    } finally {
      setBusy(null)
    }
  }

  /**
   * Regenerate flow: hosted/live domains the operator picks via checkbox
   * get re-run from step 9 with force_regen=true so the LLM produces
   * fresh content even when no custom brief / provider override is set.
   * Step 10 then re-uploads, replacing the live index. Skips DNS, SSL,
   * server provisioning — pure content rewrite.
   */
  async function submitRegen(): Promise<void> {
    const list = [...regenSelected]
    if (list.length === 0) { show("err", "Pick at least one domain to regenerate"); return }
    if (!confirm(
      `Regenerate content for ${list.length} domain(s)?\n\n` +
      `Each runs steps 9–10 (LLM content + upload). The current live ` +
      `index.php will be REPLACED with the new content.\n\n` +
      (brief
        ? `Brief: "${brief.slice(0, 120)}${brief.length > 120 ? "…" : ""}"\n\n`
        : `No brief — LLM uses the master prompt + domain name.\n\n`) +
      `Continue?`,
    )) return
    setBusy("regen")
    try {
      const ok: string[] = []
      const failed: { domain: string; reason: string }[] = []
      for (const d of list) {
        const r = await fetch(`/api/domains/${encodeURIComponent(d)}/run-from/9`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            skip_purchase: "on",
            force_regen: "on",
            custom_prompt: brief || undefined,
            custom_provider: provider || undefined,
            custom_model: model || undefined,
          }),
        })
        const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
        if (j.ok === true) ok.push(d)
        else failed.push({ domain: d, reason: String(j.error ?? j.message ?? `HTTP ${r.status}`) })
      }
      const msg = ok.length === list.length
        ? `Regeneration enqueued for all ${ok.length} domain(s)`
        : `Regeneration enqueued for ${ok.length}/${list.length}; ${failed.length} skipped (${failed.slice(0, 3).map((f) => f.domain).join(", ")}${failed.length > 3 ? "…" : ""})`
      show(failed.length === 0 ? "ok" : "err", msg)
      setRecent((prev) => [...new Set([...ok, ...prev])].slice(0, 100))
      setRegenSelected(new Set())
      await mutateWatcher()
    } finally {
      setBusy(null)
    }
  }

  return (
    <AppShell
      title="AI Site Generator"
      description="Queue one or many domains for AI-driven site generation. Reuses the full deployment pipeline (DNS, SSL, upload) — this page is a focused front-end for the AI-gen workflow."
      breadcrumbs={[{ label: "AI Generator" }]}
      accent="domains"
      actions={
        <Button
          size="sm" variant="outline" className="gap-1.5"
          onClick={() => setShowPrompt((v) => !v)}
          title="Edit the master prompt the LLM uses for every site"
        >
          <FileText className="h-3.5 w-3.5" />
          {showPrompt ? "Hide prompt settings" : "Prompt settings"}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
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

        {/* ===== Input section ===== */}
        <section className="rounded-md border border-border bg-card">
          <header className="border-b border-border px-5 py-3">
            <div className="flex items-center gap-2 text-[13px] font-semibold">
              <Sparkles className="h-3.5 w-3.5 text-status-completed" />
              Generate sites
            </div>
            <p className="mt-0.5 text-micro text-muted-foreground">
              Single domain or paste a list. The LLM uses the master prompt + domain
              name (and optional brief) to produce a Google-Ads-compliant single-page
              site, then the existing pipeline deploys it.
            </p>
          </header>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-5">
            {/* Single */}
            <div className="flex flex-col gap-2">
              <label className="text-[13px] font-medium">Single domain</label>
              <div className="flex gap-2">
                <Input
                  value={single}
                  onChange={(e) => setSingle(e.target.value)}
                  placeholder="bestkitchenappliances.com"
                  className="font-mono text-small"
                  onKeyDown={(e) => { if (e.key === "Enter" && !busy) submitSingle() }}
                />
                <Button
                  size="sm" className="gap-1.5 btn-success shrink-0"
                  onClick={submitSingle} disabled={busy !== null}
                >
                  {busy === "single"
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Play className="h-3.5 w-3.5" />}
                  Generate
                </Button>
              </div>
              <p className="text-micro text-muted-foreground">
                Adds the domain row if missing, then enqueues the full pipeline.
              </p>
            </div>

            {/* Bulk */}
            <div className="flex flex-col gap-2">
              <label className="text-[13px] font-medium">Bulk — one domain per line</label>
              <Textarea
                value={bulk}
                onChange={(e) => setBulk(e.target.value)}
                rows={5}
                spellCheck={false}
                placeholder={"healthylivinghub.com\ngreenleafrecipes.site\nappdesignstudio.io\nfreshharvestmarket.com"}
                className="font-mono text-small"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-micro text-muted-foreground">
                  Sequential — one at a time. Best for 5–50 domain batches.
                </span>
                <Button
                  size="sm" className="gap-1.5 btn-soft-success shrink-0"
                  onClick={submitBulk} disabled={busy !== null}
                >
                  {busy === "bulk"
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <ListChecks className="h-3.5 w-3.5" />}
                  Queue all
                </Button>
              </div>
            </div>
          </div>

          {/* Options */}
          <div className="border-t border-border px-5 py-4">
            <div className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Options for this run
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-micro font-medium">Provider <span className="text-muted-foreground">(empty = default)</span></label>
                <Select
                  value={provider || "__default__"}
                  onValueChange={(v) => setProvider(v === "__default__" ? "" : v)}
                >
                  <SelectTrigger size="sm" className="h-8 text-small mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">(use Settings default)</SelectItem>
                    <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                    <SelectItem value="openai">OpenAI (GPT)</SelectItem>
                    <SelectItem value="gemini">Google Gemini / Gemma</SelectItem>
                    <SelectItem value="openrouter">OpenRouter</SelectItem>
                    <SelectItem value="moonshot">Moonshot Kimi</SelectItem>
                    <SelectItem value="cloudflare">Cloudflare Workers AI</SelectItem>
                    <SelectItem value="cloudflare_pool">Cloudflare Workers AI POOL</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-micro font-medium">Model <span className="text-muted-foreground">(optional)</span></label>
                <div className="mt-1">
                  <ModelPicker
                    provider={provider || "anthropic"}
                    value={model}
                    onChange={setModel}
                    size="sm"
                  />
                </div>
              </div>
              <div>
                <label className="text-micro font-medium">Skip Spaceship purchase</label>
                <div className="mt-2 flex items-center gap-2">
                  <Checkbox
                    checked={skipPurchase}
                    onCheckedChange={(v) => setSkipPurchase(Boolean(v))}
                  />
                  <span className="text-small text-muted-foreground">
                    BYO domain (skip step 1) — recommended for AI-gen testing
                  </span>
                </div>
              </div>
            </div>
            <div className="mt-3">
              <label className="text-micro font-medium">
                Operator brief <span className="text-muted-foreground">(optional — niche / style override)</span>
              </label>
              <Textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={3}
                placeholder="e.g. Professional dental clinic landing page, teal/white palette, hero CTA, services list (cleanings/fillings/cosmetic), team blurb."
                className="font-mono text-small mt-1"
              />
              <p className="text-micro text-muted-foreground mt-1">
                Single-domain submissions get the brief; bulk runs ignore it (sequential
                bulk job doesn&apos;t carry per-domain briefs). For per-domain briefs,
                use the Regenerate dialog on each /domains/[domain] page.
              </p>
            </div>
          </div>
        </section>

        {/* ===== Regenerate existing ===== */}
        <section className="rounded-md border border-border bg-card">
          <header className="border-b border-border px-5 py-3">
            <div className="flex items-center gap-2 text-[13px] font-semibold">
              <RotateCw className="h-3.5 w-3.5 text-status-running" />
              Regenerate existing site
            </div>
            <p className="mt-0.5 text-micro text-muted-foreground">
              Pick one or more hosted/live domains to re-generate content for.
              Re-runs steps 9–10 only (LLM gen + upload) — DNS, SSL, server
              provisioning are skipped. The current <code className="text-[11px] px-1 rounded bg-muted">/public_html/index.php</code> is REPLACED
              with the new content.
            </p>
          </header>

          <div className="p-5">
            {(() => {
              const hosted = (domainsResp?.domains ?? [])
                .filter((r) => r.status === "live" || r.status === "hosted")
                .sort((a, b) => a.domain.localeCompare(b.domain))
              if (hosted.length === 0) {
                return (
                  <div className="text-small text-muted-foreground py-6 text-center">
                    No hosted/live domains yet. Generate one above first.
                  </div>
                )
              }
              const allChecked = hosted.every((r) => regenSelected.has(r.domain))
              const someChecked = hosted.some((r) => regenSelected.has(r.domain)) && !allChecked
              return (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-small">
                      <Checkbox
                        checked={allChecked ? true : someChecked ? "indeterminate" : false}
                        onCheckedChange={(v) => {
                          setRegenSelected(v ? new Set(hosted.map((r) => r.domain)) : new Set())
                        }}
                      />
                      <span>
                        Select all <span className="text-muted-foreground">({hosted.length} hosted/live)</span>
                      </span>
                    </label>
                    <span className="text-micro text-muted-foreground tabular-nums">
                      {regenSelected.size} selected
                    </span>
                  </div>
                  <div className="rounded-md border border-border max-h-[260px] overflow-y-auto divide-y divide-border">
                    {hosted.map((r) => (
                      <label
                        key={r.domain}
                        className="flex items-center gap-2 px-3 py-2 text-small hover:bg-muted/40 cursor-pointer"
                      >
                        <Checkbox
                          checked={regenSelected.has(r.domain)}
                          onCheckedChange={(v) => {
                            setRegenSelected((s) => {
                              const n = new Set(s)
                              if (v) n.add(r.domain); else n.delete(r.domain)
                              return n
                            })
                          }}
                        />
                        <span className="font-mono">{r.domain}</span>
                        <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-micro font-medium text-muted-foreground">
                          {r.status}
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-micro text-muted-foreground">
                      Uses the same Provider / Model / Brief settings above.
                      Brief blank? LLM falls back to the master prompt + domain name.
                    </p>
                    <Button
                      size="sm" className="gap-1.5 shrink-0"
                      onClick={submitRegen}
                      disabled={busy !== null || regenSelected.size === 0}
                    >
                      {busy === "regen"
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <RotateCw className="h-3.5 w-3.5" />}
                      Regenerate {regenSelected.size > 0 ? `(${regenSelected.size})` : ""}
                    </Button>
                  </div>
                </div>
              )
            })()}
          </div>
        </section>

        {/* ===== Queue ===== */}
        <section className="rounded-md border border-border bg-card">
          <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
            <div className="flex items-center gap-2 text-[13px] font-semibold">
              <ListChecks className="h-3.5 w-3.5 text-status-running" />
              Queue
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground tabular-nums">
                {queueRows.length}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm" variant="ghost" className="gap-1.5"
                onClick={() => { setRecent([]); void mutateWatcher() }}
                title="Clear the just-submitted list (this view stops tracking those domains; they keep running in the pipeline)"
              >
                Clear view
              </Button>
              <a
                href="/watcher"
                className="text-micro text-status-running hover:underline inline-flex items-center gap-1"
                title="Full pipeline watcher view"
              >
                <ExternalLink className="h-3 w-3" /> Open /watcher
              </a>
            </div>
          </header>

          {queueRows.length === 0 ? (
            <div className="px-5 py-12 text-center text-small text-muted-foreground">
              <Plus className="h-5 w-5 mx-auto mb-2 opacity-40" />
              No active jobs. Submit a domain above to start.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-small">
                <thead className="border-b border-border bg-muted/40 text-micro uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Domain</th>
                    <th className="px-4 py-2 text-left font-medium">Status</th>
                    <th className="px-4 py-2 text-left font-medium">Step</th>
                    <th className="px-4 py-2 text-left font-medium">Last log</th>
                    <th className="px-4 py-2 text-right font-medium">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {queueRows.map((r) => (
                    <tr key={r.domain} className="border-b border-border/40 last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-2 font-mono">{r.domain}</td>
                      <td className="px-4 py-2">
                        <StatusPill status={r.status} />
                      </td>
                      <td className="px-4 py-2 text-muted-foreground tabular-nums">
                        {r.step != null ? `${r.step}/10` : "—"}
                      </td>
                      <td className="px-4 py-2 text-micro text-muted-foreground truncate max-w-[420px]">
                        {r.step_message ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <a
                          href={`/domains/${encodeURIComponent(r.domain)}`}
                          className="text-status-running hover:underline inline-flex items-center gap-1"
                          title="Drill into this domain"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ===== Optional inline prompt editor ===== */}
        {showPrompt && (
          <section>
            <MasterPromptCard />
          </section>
        )}
      </div>
    </AppShell>
  )
}

function StatusPill({ status }: { status: string }) {
  const klass =
    status === "live" || status === "completed" ? "bg-status-completed/15 text-status-completed border-status-completed/30" :
    status === "hosted" || status === "ssl_installed" ? "bg-status-completed/10 text-status-completed border-status-completed/20" :
    status === "running" ? "bg-status-running/15 text-status-running border-status-running/30" :
    status === "queued" ? "bg-muted text-muted-foreground border-border" :
    status === "failed" || status === "terminal_error" ? "bg-status-terminal/15 text-status-terminal border-status-terminal/30" :
    status === "retryable_error" || status === "warning" ? "bg-status-waiting/15 text-status-waiting border-status-waiting/30" :
    "bg-muted text-muted-foreground border-border"
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium", klass)}>
      {status === "running" && <RotateCw className="h-2.5 w-2.5 animate-spin" />}
      {status}
    </span>
  )
}
