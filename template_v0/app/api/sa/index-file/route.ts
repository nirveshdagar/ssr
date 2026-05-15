import { NextResponse, type NextRequest } from "next/server"
import { readIndexFile, writeIndexFile, restoreIndexFile } from "@/lib/sa-control"
import { appendAudit } from "@/lib/repos/audit"
import { findServerByIp } from "@/lib/repos/servers"

export const runtime = "nodejs"

/**
 * Read / write / restore /public_html/index.php for a single app via SSH.
 *
 * Read:    GET  ?domain=X&server_ip=Y
 * Write:   POST { domain, server_ip, body }                — creates index.php.bak first
 * Restore: POST { domain, server_ip, action: "restore" }   — copies .bak over index.php
 */
export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url)
  const domain = (url.searchParams.get("domain") || "").trim()
  const serverIp = (url.searchParams.get("server_ip") || "").trim()
  if (!domain || !serverIp) {
    return NextResponse.json({ ok: false, error: "domain and server_ip required" }, { status: 400 })
  }
  if (!findServerByIp(serverIp)) {
    return NextResponse.json({ ok: false, error: "server_ip is not a known dashboard server" }, { status: 403 })
  }
  try {
    const r = await readIndexFile(domain, serverIp)
    return NextResponse.json({ ok: true, ...r })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 })
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const domain = ((form?.get("domain") as string | null) || "").trim()
  const serverIp = ((form?.get("server_ip") as string | null) || "").trim()
  const action = ((form?.get("action") as string | null) || "write").trim()
  if (!domain || !serverIp) {
    return NextResponse.json({ ok: false, error: "domain and server_ip required" }, { status: 400 })
  }
  if (!findServerByIp(serverIp)) {
    return NextResponse.json({ ok: false, error: "server_ip is not a known dashboard server" }, { status: 403 })
  }

  try {
    if (action === "restore") {
      const r = await restoreIndexFile(domain, serverIp)
      appendAudit("sa_index_restore", domain, `bytes=${r.bytes_restored}`, ip)
      return NextResponse.json({ ok: true, ...r, message: "Restored from backup" })
    }
    const body = ((form?.get("body") as string | null) || "")
    if (!body || body.trim().length === 0) {
      return NextResponse.json({ ok: false, error: "body cannot be empty" }, { status: 400 })
    }
    const r = await writeIndexFile(domain, serverIp, body)
    appendAudit("sa_index_write", domain, `bytes=${r.bytes_written}`, ip)
    return NextResponse.json({ ok: true, ...r, message: "Saved (backup: index.php.bak)" })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 })
  }
}
