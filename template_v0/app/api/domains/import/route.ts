import { NextResponse, type NextRequest } from "next/server"
import { addDomain, updateDomain } from "@/lib/repos/domains"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

const MUTABLE_COLS = ["cf_email", "cf_global_key", "cf_zone_id", "cf_nameservers"] as const

// Same shape used at /api/ai-generator/queue. Domain values flow from CSV
// rows into addDomain() and downstream into shell-interpolated SSH calls
// (e.g. find-public_html search). Reject malformed entries at the import
// boundary so a quote / dollar / semicolon never reaches a shell context.
const DOMAIN_SHAPE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

/** Tiny RFC-4180 CSV reader — handles quoted fields, escaped quotes, CRLF/LF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else {
        field += c
      }
    } else {
      if (c === '"') inQuotes = true
      else if (c === ",") { row.push(field); field = "" }
      else if (c === "\r") { /* skip */ }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = "" }
      else field += c
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""))
}

export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const file = form?.get("csv_file") as File | null
  if (!file) {
    return NextResponse.json({ ok: false, error: "No file uploaded (form field 'csv_file')" }, { status: 400 })
  }
  // Strip BOM if present
  let text = await file.text()
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows = parseCsv(text)
  if (rows.length < 2) {
    return NextResponse.json({ ok: false, error: "CSV needs a header row + at least one data row" }, { status: 400 })
  }
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const domainIdx = header.indexOf("domain")
  if (domainIdx < 0) {
    return NextResponse.json({ ok: false, error: "CSV header must include 'domain' column" }, { status: 400 })
  }

  let count = 0
  const rejected: { line: number; value: string }[] = []
  const colIdx: Partial<Record<typeof MUTABLE_COLS[number], number>> = {}
  for (const c of MUTABLE_COLS) {
    const i = header.indexOf(c)
    if (i >= 0) colIdx[c] = i
  }

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]
    const domain = (cells[domainIdx] ?? "").trim().toLowerCase()
    if (!domain) continue
    if (!DOMAIN_SHAPE.test(domain)) {
      rejected.push({ line: r + 1, value: domain.slice(0, 80) })
      continue
    }
    addDomain(domain)
    const updates: Record<string, string> = {}
    for (const c of MUTABLE_COLS) {
      const i = colIdx[c]
      if (i == null) continue
      const v = (cells[i] ?? "").trim()
      if (v) updates[c] = v
    }
    if (Object.keys(updates).length) {
      updateDomain(domain, updates as Parameters<typeof updateDomain>[1])
    }
    count++
  }

  appendAudit("domain_import_csv", `${count} rows`,
    `${file.name ?? "uploaded.csv"} accepted=${count} rejected=${rejected.length}`, ip)
  return NextResponse.json({
    ok: true,
    count,
    rejected: rejected.slice(0, 10),
    rejected_total: rejected.length,
    message:
      `Imported ${count} domain(s) from CSV` +
      (rejected.length ? `; ${rejected.length} rejected by shape check` : ""),
  })
}
