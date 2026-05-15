import { NextResponse, type NextRequest } from "next/server"
import { all } from "@/lib/db"
import { enqueueJob } from "@/lib/jobs"
import { appendAudit } from "@/lib/repos/audit"
import { VALID_DNS_RECORD_TYPES } from "@/lib/cloudflare"

export const runtime = "nodejs"

const MAX_BODY = 256 * 1024
const MAX_ROWS = 5000
const REQUIRED = ["domain", "type", "name", "content"]
const TRUTHY = new Set(["true", "1", "yes", "on"])

interface Row {
  domain: string
  type: string
  name: string
  content: string
  proxied: boolean
  ttl: number
}

interface ParseResult {
  rows: Row[]
  errors: { line: number; message: string }[]
}

function parseCsv(text: string, allowed: Set<string>): ParseResult {
  const rows: Row[] = []
  const errors: { line: number; message: string }[] = []
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (!lines.length) {
    errors.push({ line: 0, message: "CSV is empty or has no header row" })
    return { rows, errors }
  }
  // Naive split — adequate for our use case (no embedded commas in values).
  // Quoted-field handling lives in the Python side too; both could be
  // upgraded to a real CSV parser later.
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase())
  const missing = REQUIRED.filter((c) => !headers.includes(c))
  if (missing.length) {
    errors.push({ line: 0, message: `missing required columns: ${missing.join(", ")}` })
    return { rows, errors }
  }
  const idx = (k: string) => headers.indexOf(k)
  for (let i = 1; i < lines.length; i++) {
    if (rows.length + errors.length >= MAX_ROWS) {
      errors.push({ line: i + 1, message: `row cap ${MAX_ROWS} reached; rest skipped` })
      break
    }
    const cells = lines[i].split(",").map((c) => c.trim())
    const dom = (cells[idx("domain")] || "").toLowerCase()
    const rtype = (cells[idx("type")] || "").toUpperCase()
    const name = cells[idx("name")] || ""
    const content = cells[idx("content")] || ""
    const proxied = TRUTHY.has((cells[idx("proxied")] || "").toLowerCase())
    const ttlRaw = cells[idx("ttl")] || "1"
    const ttl = Number.parseInt(ttlRaw, 10) || 1

    if (!dom) { errors.push({ line: i + 1, message: "empty domain" }); continue }
    if (!allowed.has(dom)) { errors.push({ line: i + 1, message: `${JSON.stringify(dom)} not assigned to this CF key` }); continue }
    if (!VALID_DNS_RECORD_TYPES.includes(rtype as never)) {
      errors.push({ line: i + 1, message: `type must be one of ${VALID_DNS_RECORD_TYPES.join(", ")}; got ${JSON.stringify(rtype)}` })
      continue
    }
    if (!content) { errors.push({ line: i + 1, message: "empty content" }); continue }
    rows.push({ domain: dom, type: rtype, name, content, proxied, ttl })
  }
  return { rows, errors }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const keyId = Number(id)
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)

  let csvText = ((form?.get("csv_text") as string | null) || "").trim()
  if (!csvText) {
    const file = form?.get("csv_file")
    if (file && typeof file !== "string") {
      const buf = await (file as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer()
      csvText = new TextDecoder("utf-8").decode(buf)
    }
  }
  if (!csvText) {
    return NextResponse.json({ error: "Provide CSV (paste or upload)" }, { status: 400 })
  }
  if (Buffer.byteLength(csvText, "utf-8") > MAX_BODY) {
    return NextResponse.json({ error: "CSV body too large (>256 KiB)" }, { status: 413 })
  }

  const allowed = new Set(
    all<{ domain: string }>("SELECT domain FROM domains WHERE cf_key_id = ?", keyId).map((r) =>
      r.domain.toLowerCase(),
    ),
  )
  const { rows, errors } = parseCsv(csvText, allowed)
  if (!rows.length) {
    return NextResponse.json(
      { error: "No valid rows", errors: errors.slice(0, 8) },
      { status: 400 },
    )
  }

  const jobId = enqueueJob("cf.bulk_dns_csv", { key_id: keyId, rows })
  appendAudit(
    "cf_bulk_dns_csv",
    `cf_key=${keyId}`,
    `valid=${rows.length} skipped=${errors.length} job=${jobId}`,
    ip,
  )
  return NextResponse.json({
    ok: true,
    job_id: jobId,
    valid: rows.length,
    skipped: errors.length,
    errors: errors.slice(0, 8),
  })
}
