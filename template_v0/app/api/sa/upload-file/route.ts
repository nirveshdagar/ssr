import { NextResponse, type NextRequest } from "next/server"
import { uploadAppFile, bulkUploadFile, validateFilename } from "@/lib/sa-control"
import { appendAudit } from "@/lib/repos/audit"
import { findServerByIp } from "@/lib/repos/servers"

export const runtime = "nodejs"

const MAX_FILE_BODY = 1_000_000  // 1 MB — bigger than any legitimate index.php
const MAX_BULK_TARGETS = 1000

/**
 * Upload an arbitrary file to /public_html/ on one or many apps.
 *
 * Single:
 *   POST JSON { domain, server_ip, filename, body }
 *
 * Bulk:
 *   POST JSON { filename, body, targets: [{ domain, server_ip }, …], concurrency? }
 *
 * Filename validation: alphanumeric start, [A-Za-z0-9._-] only, no slashes,
 * no '..', max 128 chars. The editor-managed `index.php.bak` and `.htaccess`
 * are blocked from this path — modify those via the index.php drawer / the
 * automatic hardening on save.
 *
 * Files land top-level in /public_html/. Nested directories aren't supported
 * here intentionally — keeps the surface narrow + matches the
 * "side-by-side another file in all domains" use case the operator asked for.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  let body: {
    domain?: string
    server_ip?: string
    filename?: string
    body?: string
    targets?: { domain: string; server_ip: string }[]
    concurrency?: number
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "expected JSON body" }, { status: 400 })
  }

  const filename = (body.filename ?? "").trim()
  const fileBody = body.body ?? ""
  if (!fileBody) {
    return NextResponse.json({ ok: false, error: "body required (file contents cannot be empty)" }, { status: 400 })
  }
  if (fileBody.length > MAX_FILE_BODY) {
    return NextResponse.json({
      ok: false,
      error: `file body too large (${fileBody.length} > ${MAX_FILE_BODY} bytes)`,
    }, { status: 413 })
  }
  const fnErr = validateFilename(filename)
  if (fnErr) return NextResponse.json({ ok: false, error: fnErr }, { status: 400 })

  // Bulk path
  if (Array.isArray(body.targets) && body.targets.length > 0) {
    if (body.targets.length > MAX_BULK_TARGETS) {
      return NextResponse.json({
        ok: false,
        error: `too many targets (${body.targets.length} > ${MAX_BULK_TARGETS})`,
      }, { status: 413 })
    }
    const unknownIp = body.targets.find((t) => !findServerByIp(t.server_ip))
    if (unknownIp) {
      return NextResponse.json({
        ok: false,
        error: `target server_ip ${JSON.stringify(unknownIp.server_ip)} is not a known dashboard server`,
      }, { status: 403 })
    }
    try {
      const result = await bulkUploadFile(body.targets, filename, fileBody, {
        concurrency: body.concurrency,
      })
      appendAudit("sa_bulk_upload", "",
        `filename=${filename} targets=${body.targets.length} ok=${result.succeeded} failed=${result.failed}`,
        ip)
      return NextResponse.json({
        ok: true, ...result,
        message: `Uploaded ${filename} to ${result.succeeded}/${body.targets.length} app(s)` +
          (result.failed > 0 ? ` · ${result.failed} failed` : ""),
      })
    } catch (e) {
      return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 })
    }
  }

  // Single path
  const domain = (body.domain ?? "").trim()
  const serverIp = (body.server_ip ?? "").trim()
  if (!domain || !serverIp) {
    return NextResponse.json({
      ok: false,
      error: "single upload requires domain + server_ip (or use targets[] for bulk)",
    }, { status: 400 })
  }
  if (!findServerByIp(serverIp)) {
    return NextResponse.json({ ok: false, error: "server_ip is not a known dashboard server" }, { status: 403 })
  }
  try {
    const r = await uploadAppFile(domain, serverIp, filename, fileBody)
    appendAudit("sa_upload", domain,
      `filename=${filename} bytes=${r.bytes_written} via=${r.via}`, ip)
    return NextResponse.json({
      ok: true, ...r,
      message: `Uploaded ${filename} (${r.bytes_written} bytes via ${r.via})`,
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 })
  }
}
