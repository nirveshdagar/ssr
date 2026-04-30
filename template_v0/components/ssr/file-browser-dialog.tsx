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
import { Loader2, RefreshCw, Trash2, Eye, Upload as UploadIcon, FileText, X } from "lucide-react"
import { MonoCode } from "@/components/ssr/data-table"

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

export interface FileBrowserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Empty string while not opened on a row. */
  domain: string
  serverIp: string
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function FileBrowserDialog({ open, onOpenChange, domain, serverIp }: FileBrowserDialogProps) {
  const [files, setFiles] = React.useState<AppFileEntry[]>([])
  const [pubPath, setPubPath] = React.useState<string>("")
  const [loading, setLoading] = React.useState(false)
  const [errMsg, setErrMsg] = React.useState<string | null>(null)
  const [okMsg, setOkMsg] = React.useState<string | null>(null)
  const [viewing, setViewing] = React.useState<{ name: string; content: string; bytes: number } | null>(null)
  const [uploadName, setUploadName] = React.useState("")
  const [uploadBody, setUploadBody] = React.useState("")
  const [uploadBusy, setUploadBusy] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

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
      setViewing({ name, content: j.content ?? "", bytes: j.bytes ?? 0 })
    } catch (e) {
      setErrMsg((e as Error).message)
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

  function handleFilePicked(ev: React.ChangeEvent<HTMLInputElement>) {
    const f = ev.target.files?.[0]
    if (!f) return
    setUploadName(f.name)
    const reader = new FileReader()
    reader.onload = () => {
      const v = typeof reader.result === "string" ? reader.result : ""
      setUploadBody(v)
    }
    reader.onerror = () => {
      setErrMsg(`could not read ${f.name} as text`)
    }
    reader.readAsText(f)
  }

  async function doUpload() {
    if (!uploadName.trim()) { setErrMsg("filename required"); return }
    if (!uploadBody) { setErrMsg("file is empty"); return }
    setUploadBusy(true); setErrMsg(null); setOkMsg(null)
    try {
      const r = await fetch("/api/sa/upload-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain, server_ip: serverIp,
          filename: uploadName.trim(), body: uploadBody,
        }),
      })
      const j = await r.json() as SimpleResponse
      if (!j.ok) throw new Error(j.error ?? `upload failed (${r.status})`)
      setOkMsg(j.message ?? `Uploaded ${uploadName}`)
      setUploadName(""); setUploadBody("")
      if (fileInputRef.current) fileInputRef.current.value = ""
      await refresh()
    } catch (e) {
      setErrMsg((e as Error).message)
    } finally {
      setUploadBusy(false)
    }
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

            {viewing && (
              <div className="rounded-md border border-border">
                <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
                  <div className="flex items-center gap-2 text-small">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    <MonoCode>{viewing.name}</MonoCode>
                    <span className="text-micro text-muted-foreground">{formatBytes(viewing.bytes)}</span>
                  </div>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setViewing(null)} title="Close preview">
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <Textarea
                  readOnly
                  value={viewing.content}
                  className="min-h-[180px] max-h-[320px] font-mono text-micro"
                />
              </div>
            )}

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
                    className="text-small"
                  />
                  <span className="text-micro text-muted-foreground">or paste below</span>
                </div>
                <Input
                  placeholder="filename (e.g. about.html)"
                  value={uploadName}
                  onChange={(e) => setUploadName(e.target.value)}
                  className="font-mono"
                />
                <Textarea
                  placeholder="file contents…"
                  value={uploadBody}
                  onChange={(e) => setUploadBody(e.target.value)}
                  className="min-h-[100px] max-h-[200px] font-mono text-micro"
                />
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
