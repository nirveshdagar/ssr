import { NextResponse, type NextRequest } from "next/server"
import { listAppFiles, deleteAppFile, readAppFile } from "@/lib/sa-control"
import { appendAudit } from "@/lib/repos/audit"
import { findServerByIp } from "@/lib/repos/servers"

export const runtime = "nodejs"

/**
 * Browse / read / delete files in /public_html/ for a single app.
 *
 * List:   GET   ?domain=X&server_ip=Y                  → { ok, path, files: [...] }
 * Read:   GET   ?domain=X&server_ip=Y&filename=foo.txt → { ok, content, bytes, path }
 * Delete: POST  { domain, server_ip, action: "delete", filename }
 *
 * Upload uses /api/sa/upload-file (separate route — handles single + bulk
 * with concurrency). Index.php read/write goes through /api/sa/index-file.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url)
  const domain = (url.searchParams.get("domain") || "").trim()
  const serverIp = (url.searchParams.get("server_ip") || "").trim()
  const filename = (url.searchParams.get("filename") || "").trim()
  if (!domain || !serverIp) {
    return NextResponse.json({ ok: false, error: "domain and server_ip required" }, { status: 400 })
  }
  if (!findServerByIp(serverIp)) {
    return NextResponse.json({ ok: false, error: "server_ip is not a known dashboard server" }, { status: 403 })
  }
  try {
    if (filename) {
      const r = await readAppFile(domain, serverIp, filename)
      return NextResponse.json({ ok: true, ...r })
    }
    const r = await listAppFiles(domain, serverIp)
    return NextResponse.json({ ok: true, ...r })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 })
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  let body: { domain?: string; server_ip?: string; action?: string; filename?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "expected JSON body" }, { status: 400 })
  }
  const domain = (body.domain ?? "").trim()
  const serverIp = (body.server_ip ?? "").trim()
  const action = (body.action ?? "").trim()
  const filename = (body.filename ?? "").trim()

  if (!domain || !serverIp) {
    return NextResponse.json({ ok: false, error: "domain and server_ip required" }, { status: 400 })
  }
  if (!findServerByIp(serverIp)) {
    return NextResponse.json({ ok: false, error: "server_ip is not a known dashboard server" }, { status: 403 })
  }
  if (action !== "delete") {
    return NextResponse.json({ ok: false, error: "unsupported action (use 'delete'; uploads go to /api/sa/upload-file)" }, { status: 400 })
  }
  try {
    const r = await deleteAppFile(domain, serverIp, filename)
    appendAudit("sa_delete_file", domain, `filename=${filename}`, ip)
    return NextResponse.json({ ok: true, ...r, message: `Deleted ${filename}` })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 })
  }
}
