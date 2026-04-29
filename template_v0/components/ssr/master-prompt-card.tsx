"use client"

import * as React from "react"
import useSWR, { mutate as globalMutate } from "swr"
import { Save, RotateCcw, History, Loader2, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

interface PromptStatus {
  ok: boolean
  content: string
  is_default: boolean
  default_content: string
  version: number
  last_saved_at: string | null
  history_count: number
  history?: HistoryRow[]
}

interface HistoryRow {
  id: number
  version: number
  content: string
  saved_at: string
  saved_by: string | null
  reset: number
}

const fetcher = async (url: string): Promise<PromptStatus> => {
  const r = await fetch(url, { credentials: "same-origin" })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/**
 * Master prompt editor — sits inside the LLM section on /settings. The
 * editor is uncontrolled (local React state) until the operator clicks
 * Save; that way typing doesn't fire a server roundtrip per keystroke and
 * a stale SWR refetch can't clobber an in-progress edit.
 *
 * "Dirty" state highlights the Save button + warns if the operator tries
 * to navigate away.
 */
export function MasterPromptCard() {
  const { data, mutate } = useSWR<PromptStatus>(
    "/api/settings/master-prompt?history=20",
    fetcher,
    { revalidateOnFocus: false },
  )
  const [draft, setDraft] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<"save" | "reset" | null>(null)
  const [historyOpen, setHistoryOpen] = React.useState(false)

  // Hydrate the draft when the server data first arrives — but ONLY when
  // the operator hasn't started editing. Subsequent server refreshes don't
  // overwrite a dirty draft.
  React.useEffect(() => {
    if (draft != null) return
    if (!data) return
    setDraft(data.is_default ? data.default_content : data.content)
  }, [data, draft])

  const effective = draft ?? data?.content ?? ""
  const dirty = data && draft != null && draft !== (data.is_default ? data.default_content : data.content)

  async function save(): Promise<void> {
    if (draft == null) return
    setBusy("save")
    try {
      const r = await fetch("/api/settings/master-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ content: draft }),
      })
      const j = (await r.json()) as PromptStatus & { message?: string; error?: string }
      if (!r.ok) {
        alert(j.error ?? "Save failed")
        return
      }
      // Re-pull (so version + last_saved_at + history update). Reset draft
      // to null so the next render hydrates from server.
      setDraft(null)
      await mutate()
      // Also refresh /api/settings so the Saved-At banner there reflects
      // the master-prompt save (operator might be looking at multiple
      // settings widgets).
      void globalMutate("/api/settings")
    } finally {
      setBusy(null)
    }
  }

  async function resetDefault(): Promise<void> {
    if (!confirm(
      `Reset the master prompt to the curated default?\n\n` +
      `Your current customizations will be archived to history (version ${(data?.version ?? 0) + 1}). ` +
      `You can restore from history later.`,
    )) return
    setBusy("reset")
    try {
      const r = await fetch("/api/settings/master-prompt", {
        method: "DELETE", credentials: "same-origin",
      })
      const j = (await r.json()) as PromptStatus
      if (!r.ok) { alert("Reset failed"); return }
      setDraft(j.default_content)
      await mutate()
    } finally {
      setBusy(null)
    }
  }

  function loadHistory(row: HistoryRow): void {
    if (dirty && !confirm("Discard your current edits and load this version into the editor?")) {
      return
    }
    setDraft(row.content)
    setHistoryOpen(false)
  }

  if (!data) {
    return (
      <div className="rounded-md border border-border/60 bg-card p-4 text-small text-muted-foreground">
        <Loader2 className="inline h-3.5 w-3.5 animate-spin mr-2" />
        Loading master prompt…
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border/60 bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <FileText className="h-3.5 w-3.5 text-status-running" />
            Master Prompt
            <span className="rounded bg-status-running/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-status-running">
              site generator
            </span>
            {data.is_default && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                using default
              </span>
            )}
            {dirty && (
              <span className="rounded bg-status-waiting/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-status-waiting">
                unsaved
              </span>
            )}
          </div>
          <p className="mt-1 text-micro text-muted-foreground">
            What the LLM is told before generating each site (step 9). Includes
            Google Ads compliance: required Privacy / Terms / Contact /
            Disclaimer sections, content rules, output JSON envelope.
            {" "}<code className="font-mono">{"{{NICHE_BLOCKLIST}}"}</code>{" "}is substituted
            from <code className="font-mono">llm_blocked_niches</code>.
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted-foreground">
            <span>version <strong className="text-foreground tabular-nums">{data.version}</strong></span>
            {data.last_saved_at && (
              <span>· last saved <strong className="text-foreground">{data.last_saved_at}</strong></span>
            )}
            <span>· {effective.length.toLocaleString()} chars</span>
            <span>· {data.history_count} version(s) in history</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <Button
            size="sm" variant="outline"
            onClick={() => setHistoryOpen((v) => !v)}
            className="gap-1.5"
            disabled={data.history_count === 0}
            title={data.history_count > 0 ? "Browse previous versions and restore" : "No history yet — save a custom prompt to build history"}
          >
            <History className="h-3.5 w-3.5" /> History
          </Button>
          <Button
            size="sm" variant="outline" className="gap-1.5"
            onClick={resetDefault} disabled={busy !== null || data.is_default}
            title={data.is_default ? "Already on the default" : "Restore the curated baseline (your current prompt is archived to history)"}
          >
            {busy === "reset" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            Reset to default
          </Button>
          <Button
            size="sm" className="gap-1.5 btn-success"
            onClick={save} disabled={busy !== null || !dirty}
          >
            {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save prompt
          </Button>
        </div>
      </div>

      <div className="px-4 py-3">
        <Textarea
          value={effective}
          onChange={(e) => setDraft(e.target.value)}
          rows={20}
          spellCheck={false}
          className="w-full font-mono text-[12.5px] leading-relaxed"
          placeholder="Master prompt — leave empty to use the curated default."
        />
        <p className="mt-2 text-micro text-muted-foreground">
          Tips: use{" "}
          <code className="font-mono">{"{{NICHE_BLOCKLIST}}"}</code>{" "}as inline placeholder for the
          comma-separated blocklist phrase, and{" "}
          <code className="font-mono">{"{{NICHE_BLOCKLIST_RULE}}"}</code>{" "}for the bulleted rule
          line. Both auto-substituted at generation time. The system prompt
          and the operator&apos;s per-run brief are concatenated, so leave
          niche-specific instructions to the brief — keep this prompt about
          STRUCTURE / SAFETY / OUTPUT ENVELOPE.
        </p>
      </div>

      {historyOpen && data.history && data.history.length > 0 && (
        <div className="border-t border-border/60 px-4 py-3">
          <div className="text-[13px] font-semibold mb-2">Recent versions</div>
          <ul className="flex flex-col gap-1.5">
            {data.history.map((h) => (
              <li
                key={h.id}
                className={cn(
                  "flex items-center justify-between gap-3 rounded border border-border/60 bg-muted/20 px-2.5 py-1.5 text-small",
                  h.reset === 1 && "border-status-completed/30 bg-status-completed/5",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono tabular-nums text-micro">v{h.version}</span>
                    <span className="text-micro text-muted-foreground">{h.saved_at}</span>
                    {h.reset === 1 && (
                      <span className="text-micro text-status-completed">(reset to default)</span>
                    )}
                  </div>
                  <div className="text-micro text-muted-foreground truncate font-mono">
                    {h.content.slice(0, 140).replace(/\s+/g, " ")}…
                  </div>
                </div>
                <Button
                  size="sm" variant="ghost"
                  className="text-status-running hover:bg-status-running/10"
                  onClick={() => loadHistory(h)}
                  title="Load this version into the editor (you still need to click Save)"
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
