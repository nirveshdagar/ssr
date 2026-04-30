import { NextResponse, type NextRequest } from "next/server"
import { addCfKey } from "@/lib/cf-key-pool"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

// Tighter cap than other bulk endpoints because each row makes a serial
// CF /accounts probe with a 15s timeout — 200 rows ≈ 50 minutes worst-case.
const MAX_BULK = 200

interface BulkRow {
  email: string
  api_key: string
  alias: string | null
}

interface ResultRow {
  email: string
  alias: string | null
  ok: boolean
  id?: number
  error?: string
}

const CF_API = "https://api.cloudflare.com/client/v4"

/**
 * Bulk add Cloudflare API keys. Accepts EITHER:
 *   - JSON: { rows: [{email, api_key, alias?}, ...] }
 *   - FormData with `csv_text` (paste) OR `csv_file` (upload). Header row
 *     must include `email` and `api_key`; `alias` (or `name`) is optional.
 *
 * Per-row verification: hits CF /accounts before insert (same as the
 * single-key add route) so a bad key never reaches the pool. Per-row
 * failures don't abort the rest — operator gets a per-row report.
 *
 * Idempotent: rows whose `email` already exists in the pool are skipped
 * with `error="already exists"` and don't overwrite.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null

  let rows: BulkRow[] = []
  const ct = req.headers.get("content-type") ?? ""
  try {
    if (ct.includes("application/json")) {
      const body = (await req.json()) as { rows?: unknown }
      if (!Array.isArray(body.rows)) {
        return NextResponse.json({ ok: false, error: "expected JSON body { rows: [...] }" }, { status: 400 })
      }
      rows = body.rows.map((r) => normalizeRow(r as Record<string, unknown>))
    } else {
      const form = await req.formData()
      const csvText = await readCsv(form)
      if (!csvText) {
        return NextResponse.json({
          ok: false,
          error: "Provide csv_file (upload), csv_text (paste), or a JSON body with rows[]",
        }, { status: 400 })
      }
      rows = parseCsvRows(csvText)
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: `parse failed: ${(e as Error).message}` }, { status: 400 })
  }

  rows = rows.filter((r) => r.email && r.api_key)
  if (rows.length === 0) {
    return NextResponse.json({
      ok: false,
      error: "No valid rows found (each row needs both email and api_key)",
    }, { status: 400 })
  }
  if (rows.length > MAX_BULK) {
    return NextResponse.json(
      { ok: false, error: `too many rows (${rows.length} > ${MAX_BULK}); each row makes a CF API probe` },
      { status: 413 },
    )
  }

  const results: ResultRow[] = []
  for (const r of rows) {
    const result: ResultRow = { email: r.email, alias: r.alias, ok: false }
    // Per-row verify via CF /accounts. Same as single-add — surface CF's
    // own error verbatim so the operator can fix typos / wrong-account-type.
    let acctId = ""
    try {
      const cf = await fetch(`${CF_API}/accounts`, {
        headers: {
          "X-Auth-Email": r.email,
          "X-Auth-Key": r.api_key,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      })
      if (cf.status !== 200) {
        result.error = `CF rejected (${cf.status}): ${(await cf.text()).slice(0, 160)}`
        results.push(result)
        continue
      }
      const j = (await cf.json()) as { result?: { id?: string }[] }
      const accts = j.result ?? []
      if (accts.length === 0) {
        result.error = "CF auth ok but no accounts returned (billing not set up?)"
        results.push(result)
        continue
      }
      acctId = accts[0].id ?? ""
    } catch (e) {
      result.error = `verify failed: ${(e as Error).message}`
      results.push(result)
      continue
    }
    try {
      const id = addCfKey({ email: r.email, apiKey: r.api_key, alias: r.alias, cfAccountId: acctId })
      result.ok = true
      result.id = id
    } catch (e) {
      const msg = (e as Error).message
      result.error = /already exists/.test(msg) ? "already exists" : msg
    }
    results.push(result)
  }

  const added = results.filter((r) => r.ok).length
  const errored = results.length - added
  appendAudit(
    "cf_key_bulk_add", "",
    `submitted=${rows.length} added=${added} errored=${errored}`,
    ip,
  )
  return NextResponse.json({
    ok: true,
    submitted: rows.length,
    added,
    errored,
    results,
    message: `Added ${added}/${rows.length} CF key(s)` + (errored > 0 ? `; ${errored} failed` : ""),
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeRow(o: Record<string, unknown>): BulkRow {
  return {
    email: String(o.email ?? "").trim().toLowerCase(),
    api_key: String(o.api_key ?? o.apiKey ?? "").trim(),
    alias: ((): string | null => {
      const v = String(o.alias ?? o.name ?? "").trim()
      return v || null
    })(),
  }
}

async function readCsv(form: FormData): Promise<string | null> {
  const file = form.get("csv_file")
  if (file instanceof File) {
    let text = await file.text()
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return text
  }
  const pasted = form.get("csv_text")
  if (typeof pasted === "string" && pasted.trim()) return pasted
  return null
}

/** Tiny RFC-4180 CSV parser — same shape as /api/domains/import. */
function parseCsvRows(text: string): BulkRow[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ",") { row.push(field); field = "" }
      else if (c === "\r") { /* skip */ }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = "" }
      else field += c
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row) }
  const cleaned = rows.filter((r) => !(r.length === 1 && r[0] === ""))
  if (cleaned.length < 2) return []
  const header = cleaned[0].map((h) => h.trim().toLowerCase())
  const emailIdx = header.indexOf("email")
  const keyIdx = header.findIndex((h) => h === "api_key" || h === "key" || h === "apikey")
  const aliasIdx = header.findIndex((h) => h === "alias" || h === "name")
  if (emailIdx < 0 || keyIdx < 0) return []
  const out: BulkRow[] = []
  for (let r = 1; r < cleaned.length; r++) {
    const cells = cleaned[r]
    out.push({
      email: (cells[emailIdx] ?? "").trim().toLowerCase(),
      api_key: (cells[keyIdx] ?? "").trim(),
      alias: aliasIdx >= 0 ? ((cells[aliasIdx] ?? "").trim() || null) : null,
    })
  }
  return out
}
