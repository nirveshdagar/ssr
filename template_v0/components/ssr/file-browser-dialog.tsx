"use client"

import * as React from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Loader2, RefreshCw, Trash2, Eye, Upload as UploadIcon, FileText, X, AlertTriangle, CheckCircle2, Save } from "lucide-react"
import { MonoCode } from "@/components/ssr/data-table"
import { domainActions } from "@/lib/api-actions"

interface AppFileEntry {
  name: string
  kind: string
  bytes: number
  modified: string
}

interface ListResponse {
  ok: boolean
  error?: string
  path?: string
  files?: AppFileEntry[]
}

interface ReadResponse {
  ok: boolean
  error?: string
  content?: string
  bytes?: number
  path?: string
}

interface SimpleResponse {
  ok: boolean
  error?: string
  message?: string
}

/**
 * Live + content snapshot from the parent row so the dialog can show "why
 * are you here" — e.g. DEFAULT PAGE detected, click Redeploy. Optional;
 * when not provided, the banner is hidden and the dialog behaves like a
 * pure file browser.
 */
export interface FileBrowserSnapshot {
  liveOk: boolean | null
  liveReason: string | null
  liveHttpStatus: number | null
  liveCheckedAt: string | null
  contentOk: boolean | null
  contentCheckedAt: string | null
}

export interface FileBrowserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Empty string while not opened on a row. */
  domain: string
  serverIp: string
  /** Live + content state from the parent row. Hides the banner if omitted. */
  snapshot?: FileBrowserSnapshot
  /** Called after the dialog mutates state the parent should re-fetch
   *  (re-probe / redeploy). Parent typically wires this to `mutate()` from
   *  useDomains so the row badge updates without page refresh. */
  onParentRefresh?: () => void
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function FileBrowserDialog({ open, onOpenChange, domain, serverIp, snapshot, onParentRefresh }: FileBrowserDialogProps) {
  const [files, setFiles] = React.useState<AppFileEntry[]>([])
  const [pubPath, setPubPath] = React.useState<string>("")
  const [loading, setLoading] = React.useState(false)
  const [errMsg, setErrMsg] = React.useState<string | null>(null)
  const [okMsg, setOkMsg] = React.useState<string | null>(null)
  const [viewing, setViewing] = React.useState<{
    name: string
    /** content as last saved (the read body OR the last successful write) */
    original: string
    /** content as currently in the textarea — may diverge from `original` */
    edited: string
    bytes: number
  } | null>(null)
  const [savingFile, setSavingFile] = React.useState(false)
  const [uploadName, setUploadName] = React.useState("")
  const [uploadBody, setUploadBody] = React.useState("")
  const [uploadBusy, setUploadBusy] = React.useState(false)
  const [bannerBusy, setBannerBusy] = React.useState<"reprobe" | "redeploy" | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  async function reprobe() {
    if (bannerBusy) return
    setBannerBusy("reprobe"); setErrMsg(null); setOkMsg(null)
    try {
      const r = await domainActions.checkLiveNow(domain) as {
        ok: boolean
        data?: { result?: boolean; reason?: string; http_status?: number | null; content_ok?: boolean | null }
        error?: string
      }
      if (!r.ok) throw new Error(r.error ?? "re-probe failed")
      const d = r.data ?? {}
      const text = d.result
        ? d.content_ok === false
          ? `Live (HTTP ${d.http_status ?? 200}) — but DEFAULT PAGE serving (files not deployed)`
          : `Live — HTTP ${d.http_status ?? 200}`
        : `DOWN — ${d.reason ?? "?"}${d.http_status != null ? ` (HTTP ${d.http_status})` : ""}`
      setOkMsg(text)
      onParentRefresh?.()
    } catch (e) {
      setErrMsg((e as Error).message)
    } finally {
      setBannerBusy(null)
    }
  }

  async function redeployIndex() {
    if (bannerBusy) return
    setBannerBusy("redeploy"); setErrMsg(null); setOkMsg(null)
    try {
      const r = await domainActions.runFromStep(domain, 10, { skipPurchase: true })
      if (!r.ok) throw new Error(r.error ?? r.message ?? "redeploy enqueue failed")
      setOkMsg(r.message ?? `Redeploy enqueued from step 10 for ${domain}`)
      onParentRefresh?.()
    } catch (e) {
      setErrMsg((e as Error).message)
    } finally {
      setBannerBusy(null)
    }
  }

  const refresh = React.useCallback(async () => {
    if (!domain || !serverIp) return
    setLoading(true); setErrMsg(null)
    try {
      const r = await fetch(
        `/api/sa/files?domain=${encodeURIComponent(domain)}&server_ip=${encodeURIComponent(serverIp)}`,
      )
      const j = await r.json() as ListResponse
      if (!j.ok) {
        setErrMsg(j.error ?? `list failed (${r.status})`)
        setFiles([]); setPubPath("")
      } else {
        setFiles(j.files ?? [])
        setPubPath(j.path ?? "")
      }
    } catch (e) {
      setErrMsg((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [domain, serverIp])

  React.useEffect(() => {
    if (open && domain && serverIp) {
      setViewing(null); setOkMsg(null); setErrMsg(null)
      setUploadName(""); setUploadBody("")
      void refresh()
    }
  }, [open, domain, serverIp, refresh])

  async function viewFile(name: string) {
    setErrMsg(null); setOkMsg(null)
    try {
      const r = await fetch(
        `/api/sa/files?domain=${encodeURIComponent(domain)}` +
        `&server_ip=${encodeURIComponent(serverIp)}` +
        `&filename=${encodeURIComponent(name)}`,
      )
      const j = await r.json() as ReadResponse
      if (!j.ok) throw new Error(j.error ?? `read failed (${r.status})`)
      const content = j.content ?? ""
      setViewing({ name, original: content, edited: content, bytes: j.bytes ?? 0 })
    } catch (e) {
      setErrMsg((e as Error).message)
    }
  }

  async function saveViewedFile() {
    if (!viewing || savingFile) return
    setSavingFile(true); setErrMsg(null); setOkMsg(null)
    try {
      // Special-case index.php: route through /api/sa/index-file so the
      // editor's .bak side effect runs (write creates index.php.bak first).
      // Other files go through the regular upload-file endpoint.
      if (viewing.name.toLowerCase() === "index.php") {
        const fd = new FormData()
        fd.set("domain", domain)
        fd.set("server_ip", serverIp)
        fd.set("body", viewing.edited)
        const r = await fetch("/api/sa/index-file", { method: "POST", body: fd })
        const j = await r.json() as SimpleResponse
        if (!j.ok) throw new Error(j.error ?? `save failed (${r.status})`)
        setOkMsg(j.message ?? `Saved ${viewing.name}`)
      } else {
        const r = await fetch("/api/sa/upload-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            domain, server_ip: serverIp,
            filename: viewing.name, body: viewing.edited,
          }),
        })
        const j = await r.json() as SimpleResponse
        if (!j.ok) throw new Error(j.error ?? `save failed (${r.status})`)
        setOkMsg(j.message ?? `Saved ${viewing.name}`)
      }
      // Pin the new content as the "original" so subsequent edits show
      // dirty state correctly.
      setViewing((v) => v ? { ...v, original: v.edited, bytes: v.edited.length } : v)
      await refresh()
    } catch (e) {
      setErrMsg((e as Error).message)
    } finally {
      setSavingFile(false)
    }
  }

  async function deleteFile(name: string) {
    if (!confirm(`Delete ${name} from /public_html on ${domain}?\n\nThis cannot be undone.`)) return
    setErrMsg(null); setOkMsg(null)
    try {
      const r = await fetch("/api/sa/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain, server_ip: serverIp, action: "delete", filename: name }),
      })
      const j = await r.json() as SimpleResponse
      if (!j.ok) throw new Error(j.error ?? `delete failed (${r.status})`)
      setOkMsg(j.message ?? `Deleted ${name}`)
      if (viewing?.name === name) setViewing(null)
      await refresh()
    } catch (e) {
      setErrMsg((e as Error).message)
    }
  }

  // Reusable upload helper. Used by both the file picker (auto-uploads on
  // selection) and the manual "paste body + click Upload" path.
  async function uploadFile(filename: string, body: string): Promise<void> {
    if (!filename.trim()) { setErrMsg("filename required"); return }
    if (!body) { setErrMsg("file is empty"); return }
    setUploadBusy(true); setErrMsg(null); setOkMsg(null)
    try {
      const r = await fetch("/api/sa/upload-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain, server_ip: serverIp,
          filename: filename.trim(), body,
        }),
      })
      const j = await r.json() as SimpleResponse
      if (!j.ok) throw new Error(j.error ?? `upload failed (${r.status})`)
      setOkMsg(j.message ?? `Uploaded ${filename}`)
      setUploadName(""); setUploadBody("")
      if (fileInputRef.current) fileInputRef.current.value = ""
      await refresh()
    } catch (e) {
      setErrMsg((e as Error).message)
    } finally {
      setUploadBusy(false)
    }
  }

  function handleFilePicked(ev: React.ChangeEvent<HTMLInputElement>) {
    const f = ev.target.files?.[0]
    if (!f) return
    // The upload-file API only accepts text bodies (FileReader.readAsText
    // would return garbage for binaries → server-side write would write
    // garbled data). Detect common binary types early and tell the user.
    const looksBinary = /\.(png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|woff2?|ttf|otf|mp[34]|mov)$/i.test(f.name)
    if (looksBinary) {
      setErrMsg(`'${f.name}' looks like a binary file — upload-file currently supports text only. Use the SA dashboard for binary uploads.`)
      if (fileInputRef.current) fileInputRef.current.value = ""
      return
    }
    setUploadName(f.name)
    const reader = new FileReader()
    reader.onload = () => {
      const v = typeof reader.result === "string" ? reader.result : ""
      setUploadBody(v)
      // Auto-upload as soon as the file content is loaded — the picker
      // already conveys the operator's intent ("upload this"). Removes
      // the trap where user clicks Upload too early (before FileReader
      // finishes) and nothing happens.
      void uploadFile(f.name, v)
    }
    reader.onerror = () => {
      setErrMsg(`could not read ${f.name} as text`)
    }
    reader.readAsText(f)
  }

  async function doUpload() {
    return uploadFile(uploadName, uploadBody)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-2">
          <DialogTitle>Files — {domain}</DialogTitle>
          <DialogDescription>
            {pubPath
              ? <>Top-level files in <MonoCode>{pubPath}</MonoCode></>
              : "Loading…"}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          <div className="flex flex-col gap-3">
            {snapshot && (() => {
              // Severity ladder mirrors the /domains Status badge:
              // DOWN > DEFAULT PAGE > Live > unknown.
              const isDown = snapshot.liveOk === false
              const isDefault = snapshot.liveOk === true && snapshot.contentOk === false
              const isLive = snapshot.liveOk === true && snapshot.contentOk !== false
              const variant = isDown
                ? "border-status-terminal/40 bg-status-terminal/10 text-status-terminal"
                : isDefault
                ? "border-status-retryable/40 bg-status-retryable/10 text-status-retryable"
                : isLive
                ? "border-status-completed/40 bg-status-completed/10 text-status-completed"
                : "border-border bg-muted/40 text-muted-foreground"
              const Icon = isDown || isDefault ? AlertTriangle : isLive ? CheckCircle2 : RefreshCw
              const headline = isDown
                ? `DOWN — ${snapshot.liveReason ?? "?"}${snapshot.liveHttpStatus != null ? ` (HTTP ${snapshot.liveHttpStatus})` : ""}`
                : isDefault
                ? "Default page detected — files weren't deployed"
                : isLive
                ? `Live — HTTP ${snapshot.liveHttpStatus ?? 200}`
                : "Live state unknown"
              const sub = isDefault
                ? "SA welcome / Apache default is serving instead of the generated index. Click Redeploy to push step 10 again."
                : isDown
                ? "HTTPS probe failed. Re-probe to see if it's transient, or use the Redeploy button if you suspect a content issue."
                : snapshot.contentCheckedAt
                ? `Last checked ${snapshot.contentCheckedAt}`
                : snapshot.liveCheckedAt
                ? `Last checked ${snapshot.liveCheckedAt}`
                : ""
              return (
                <div className={`rounded-md border px-3 py-2 ${variant}`}>
                  <div className="flex items-start gap-2">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-small font-medium">{headline}</div>
                      {sub && <div className="text-micro opacity-80 mt-0.5">{sub}</div>}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        variant="outline" size="sm" className="h-7 gap-1.5"
                        onClick={reprobe}
                        disabled={bannerBusy !== null}
                        title="Run a fresh HTTPS + content probe right now"
                      >
                        {bannerBusy === "reprobe"
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <RefreshCw className="h-3 w-3" />}
                        Re-probe
                      </Button>
                      {(isDefault || isDown) && (
                        <Button
                          variant="default" size="sm" className="h-7 gap-1.5"
                          onClick={redeployIndex}
                          disabled={bannerBusy !== null}
                          title="Enqueue runFromStep(10) — re-uploads index.php to /public_html"
                        >
                          {bannerBusy === "redeploy"
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <UploadIcon className="h-3 w-3" />}
                          Redeploy
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })()}

            <div className="flex items-center justify-between gap-2">
              <span className="text-small text-muted-foreground">
                {loading ? "Loading…" : `${files.length} file${files.length === 1 ? "" : "s"}`}
              </span>
              <Button variant="outline" size="sm" onClick={refresh} disabled={loading} className="gap-1.5">
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Refresh
              </Button>
            </div>

            {okMsg && (
              <div className="rounded-md border border-status-completed/40 bg-status-completed/10 px-3 py-2 text-small text-status-completed">
                {okMsg}
              </div>
            )}
            {errMsg && (
              <div className="rounded-md border border-status-terminal/40 bg-status-terminal/10 px-3 py-2 text-small text-status-terminal">
                {errMsg}
              </div>
            )}

            <div className="rounded-md border border-border">
              <table className="w-full text-small">
                <thead className="border-b border-border bg-muted/40">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Name</th>
                    <th className="px-3 py-2 text-right font-medium">Size</th>
                    <th className="px-3 py-2 text-left font-medium">Modified</th>
                    <th className="px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {files.length === 0 && !loading && (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                        No files
                      </td>
                    </tr>
                  )}
                  {files.map((f) => {
                    const isDir = f.kind === "d"
                    const isProtected = ["index.php", "index.php.bak", ".htaccess"].includes(f.name.toLowerCase())
                    return (
                      <tr key={f.name} className="border-t border-border">
                        <td className="px-3 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                            <MonoCode>{f.name}</MonoCode>
                            {isDir && <span className="text-micro text-muted-foreground">(dir)</span>}
                            {isProtected && <span className="text-micro text-muted-foreground">protected</span>}
                          </div>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                          {isDir ? "—" : formatBytes(f.bytes)}
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground">{f.modified}</td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost" size="icon" className="h-7 w-7"
                              title={`View ${f.name}`}
                              disabled={isDir}
                              onClick={() => viewFile(f.name)}
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 text-status-terminal hover:bg-status-terminal/10 hover:text-status-terminal"
                              title={isProtected ? "Protected — cannot delete from here" : `Delete ${f.name}`}
                              disabled={isDir || isProtected}
                              onClick={() => deleteFile(f.name)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {viewing && (() => {
              const dirty = viewing.edited !== viewing.original
              return (
                <div className="rounded-md border border-border">
                  <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
                    <div className="flex items-center gap-2 text-small">
                      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                      <MonoCode>{viewing.name}</MonoCode>
                      <span className="text-micro text-muted-foreground">{formatBytes(viewing.bytes)}</span>
                      {dirty && <span className="text-micro text-status-retryable">● modified</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="default" size="sm" className="h-7 gap-1.5"
                        onClick={saveViewedFile}
                        disabled={!dirty || savingFile}
                        title={dirty ? `Save changes to ${viewing.name}` : "No changes"}
                      >
                        {savingFile ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                        Save
                      </Button>
                      <Button
                        variant="ghost" size="icon" className="h-7 w-7"
                        onClick={() => {
                          if (dirty && !confirm("Discard unsaved changes?")) return
                          setViewing(null)
                        }}
                        title="Close preview"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <Textarea
                    value={viewing.edited}
                    onChange={(e) => setViewing((v) => v ? { ...v, edited: e.target.value } : v)}
                    spellCheck={false}
                    className="min-h-[180px] max-h-[320px] font-mono text-micro"
                  />
                </div>
              )
            })()}

            <div className="rounded-md border border-border">
              <div className="border-b border-border bg-muted/40 px-3 py-2 text-small font-medium">
                Upload file
              </div>
              <div className="flex flex-col gap-2 px-3 py-3">
                <div className="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    onChange={handleFilePicked}
                    disabled={uploadBusy}
                    className="text-small"
                  />
                  {uploadBusy
                    ? <span className="inline-flex items-center gap-1 text-micro text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> uploading…
                      </span>
                    : <span className="text-micro text-muted-foreground">picks auto-upload, or paste below</span>}
                </div>
                <Input
                  placeholder="filename (e.g. about.html) — letters, digits, . _ - only"
                  value={uploadName}
                  onChange={(e) => setUploadName(e.target.value)}
                  disabled={uploadBusy}
                  className="font-mono"
                />
                <Textarea
                  placeholder="file contents…"
                  value={uploadBody}
                  onChange={(e) => setUploadBody(e.target.value)}
                  disabled={uploadBusy}
                  className="min-h-[100px] max-h-[200px] font-mono text-micro"
                />
                {(!uploadName.trim() || !uploadBody) && !uploadBusy && (
                  <div className="text-micro text-muted-foreground">
                    {!uploadName.trim() && !uploadBody
                      ? "Pick a file above OR enter filename + paste contents below to enable Upload."
                      : !uploadName.trim()
                      ? "Filename required."
                      : "File contents required (paste into the box, or pick a file above)."}
                  </div>
                )}
                <div className="flex justify-end">
                  <Button
                    onClick={doUpload}
                    disabled={uploadBusy || !uploadName.trim() || !uploadBody}
                    className="gap-1.5"
                  >
                    {uploadBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadIcon className="h-3.5 w-3.5" />}
                    Upload
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
