import { NextResponse, type NextRequest } from "next/server"
import { addCfKey } from "@/lib/cf-key-pool"
import { findExistingEmails } from "@/lib/repos/cf-keys"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

// Each row makes a CF /accounts probe (15s timeout). Probes run in a
// bounded pool (PROBE_CONCURRENCY) so 1000 rows complete in a few minutes
// rather than ~4 hours serially. Matches the 1000 cap on other bulk routes.
const MAX_BULK = 1000
/** How many CF /accounts probes can be in flight at once. Conservative
 *  enough that CF won't account-level rate-limit, fast enough that a
 *  500-row paste completes in well under 5 min. */
const PROBE_CONCURRENCY = 4

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
      const parsed = parseCsvRows(csvText)
      rows = parsed.rows
      if (rows.length === 0) {
        // Surface the parser's reason verbatim — operator needs to know
        // whether the file is empty, header is malformed, or columns don't
        // match. Generic "no valid rows" wastes a round-trip.
        return NextResponse.json({
          ok: false,
          error: parsed.problem ?? "CSV had no parseable rows",
          headers_found: parsed.foundHeaders ?? null,
          expected_headers: ["email", "api_key (or 'key'/'apikey')", "alias (or 'name', optional)"],
        }, { status: 400 })
      }
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: `parse failed: ${(e as Error).message}` }, { status: 400 })
  }

  const before = rows.length
  rows = rows.filter((r) => r.email && r.api_key)
  if (rows.length === 0) {
    return NextResponse.json({
      ok: false,
      error: `All ${before} parsed row(s) had a blank email or api_key — check the values, not just the header.`,
    }, { status: 400 })
  }
  if (rows.length > MAX_BULK) {
    return NextResponse.json(
      { ok: false, error: `too many rows (${rows.length} > ${MAX_BULK}); each row makes a CF API probe` },
      { status: 413 },
    )
  }

  // Pre-flight dedup against the existing pool. At 500-key scale, the
  // operator's CSV will absolutely contain rows that were already imported
  // in a previous run; we don't want to burn a 15s CF /accounts probe per
  // dupe just to learn it then explodes on the unique-constraint INSERT
  // with a vague message.
  const existing = findExistingEmails(rows.map((r) => r.email))

  // Bounded-concurrency pool. Workers race for the shared cursor; each
  // worker writes its result back into the `results` array at the index
  // it claimed, preserving input order in the response. addCfKey writes
  // to SQLite — node:sqlite serializes its own writes, so a few parallel
  // INSERTs don't need extra locking here.
  const results: ResultRow[] = new Array<ResultRow>(rows.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= rows.length) return
      results[i] = await processRow(rows[i], existing)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, rows.length) }, () => worker()),
  )

  const added = results.filter((r) => r.ok).length
  const duplicates = results.filter((r) => r.error === "already in pool").length
  const errored = results.length - added - duplicates
  appendAudit(
    "cf_key_bulk_add", "",
    `submitted=${rows.length} added=${added} duplicates=${duplicates} errored=${errored}`,
    ip,
  )
  return NextResponse.json({
    ok: true,
    submitted: rows.length,
    added,
    duplicates,
    errored,
    results,
    message: `Added ${added}/${rows.length} CF key(s)` +
      (duplicates > 0 ? `; ${duplicates} already in pool` : "") +
      (errored > 0 ? `; ${errored} failed` : ""),
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One row's CF /accounts verify + INSERT, mirroring single-add. Pre-checks
 *  the dedup set first so dupes skip the CF probe entirely. Never throws —
 *  failures become the row's `error` field. */
async function processRow(r: BulkRow, existing: Set<string>): Promise<ResultRow> {
  const result: ResultRow = { email: r.email, alias: r.alias, ok: false }
  if (existing.has(r.email)) {
    result.error = "already in pool"
    return result
  }
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
      return result
    }
    const j = (await cf.json()) as { result?: { id?: string }[] }
    const accts = j.result ?? []
    if (accts.length === 0) {
      result.error = "CF auth ok but no accounts returned (billing not set up?)"
      return result
    }
    acctId = accts[0].id ?? ""
  } catch (e) {
    result.error = `verify failed: ${(e as Error).message}`
    return result
  }
  try {
    const id = addCfKey({ email: r.email, apiKey: r.api_key, alias: r.alias, cfAccountId: acctId })
    result.ok = true
    result.id = id
  } catch (e) {
    const msg = (e as Error).message
    // Race-only fallback: another caller could still slip a dupe in
    // between our pre-flight SELECT and the INSERT. Treat the same way.
    result.error = /already exists/.test(msg) ? "already in pool" : msg
  }
  return result
}

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
    // Normalize line endings: \r\n (Windows) and bare \r (classic Mac /
    // some Excel exports) both become \n. The parser only splits on \n
    // and ignores stray \r, so a \r-only file would otherwise be read as
    // one giant line → "only a header row" error.
    text = text.replace(/\r\n?/g, "\n")
    return text
  }
  const pasted = form.get("csv_text")
  if (typeof pasted === "string" && pasted.trim()) {
    return pasted.replace(/\r\n?/g, "\n")
  }
  return null
}

interface ParsedCsv {
  rows: BulkRow[]
  /** Lower-cased header columns we detected (empty if no header row). */
  foundHeaders?: string[]
  /** Human-readable reason `rows` is empty. Only set on the empty-result paths. */
  problem?: string
}

/** Tiny RFC-4180 CSV parser — same shape as /api/domains/import. */
function parseCsvRows(text: string): ParsedCsv {
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
  if (cleaned.length === 0) {
    return { rows: [], problem: "CSV is empty" }
  }
  if (cleaned.length < 2) {
    return {
      rows: [],
      foundHeaders: cleaned[0].map((h) => h.trim().toLowerCase()),
      problem: "CSV only has a header row — no data rows after it",
    }
  }
  const header = cleaned[0].map((h) => h.trim().toLowerCase())
  const emailIdx = header.indexOf("email")
  const keyIdx = header.findIndex((h) => h === "api_key" || h === "key" || h === "apikey")
  const aliasIdx = header.findIndex((h) => h === "alias" || h === "name")
  if (emailIdx < 0 || keyIdx < 0) {
    const missing: string[] = []
    if (emailIdx < 0) missing.push("'email'")
    if (keyIdx < 0) missing.push("'api_key' (or 'key' / 'apikey')")
    return {
      rows: [],
      foundHeaders: header,
      problem:
        `CSV header is missing required column(s): ${missing.join(" and ")}. ` +
        `Found columns: [${header.join(", ")}]. ` +
        `Expected first row to be exactly: email,api_key,alias`,
    }
  }
  const out: BulkRow[] = []
  for (let r = 1; r < cleaned.length; r++) {
    const cells = cleaned[r]
    out.push({
      email: (cells[emailIdx] ?? "").trim().toLowerCase(),
      api_key: (cells[keyIdx] ?? "").trim(),
      alias: aliasIdx >= 0 ? ((cells[aliasIdx] ?? "").trim() || null) : null,
    })
  }
  return { rows: out, foundHeaders: header }
}
