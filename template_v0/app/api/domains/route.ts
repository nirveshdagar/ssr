import { NextResponse, type NextRequest } from "next/server"
import { addDomain, listDomains } from "@/lib/repos/domains"
import { appendAudit } from "@/lib/repos/audit"
import { all } from "@/lib/db"

export const runtime = "nodejs"

interface CurrentStepRow {
  domain: string
  step_num: number
  step_status: string
  step_name: string
  message: string | null
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i

function validate(d: string): string | null {
  const s = d.trim().toLowerCase()
  if (!s) return null
  if (s.length > 253) return null
  return DOMAIN_RE.test(s) ? s : null
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const search = url.searchParams.get("q")?.trim() ?? ""
  const status = url.searchParams.get("status")?.trim() ?? ""

  let domains = listDomains()

  // Multi-token bulk-list filter (mirrors Flask /domains route)
  const tokens = search.split(/[,\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean)
  if (tokens.length > 1) {
    const wanted = new Set(tokens)
    domains = domains.filter((d) => wanted.has(d.domain.toLowerCase()))
  } else if (search) {
    const s = search.toLowerCase()
    domains = domains.filter(
      (d) =>
        d.domain.toLowerCase().includes(s) ||
        (d.cf_email || "").toLowerCase().includes(s) ||
        (d.current_proxy_ip || "").includes(s),
    )
  }

  if (status) domains = domains.filter((d) => d.status === status)

  // Enrich each domain with its CURRENT step from step_tracker so the
  // dashboard's progress bar can render which step is in flight + its
  // last message. "Current" = the highest step_num that has any activity
  // (running first, else last completed/warning/failed/skipped). Without
  // this enrichment, the progress bar always reads step=0 and looks
  // empty even while a pipeline is mid-flight.
  let currentSteps: Map<string, CurrentStepRow> = new Map()
  if (domains.length > 0) {
    const placeholders = domains.map(() => "?").join(",")
    const args = domains.map((d) => d.domain)
    // Pick the step_tracker row with the highest priority per domain:
    //   running > completed/warning/failed > skipped > pending
    // and within priority, the highest step_num. Single SQL pass.
    const rows = all<CurrentStepRow>(
      `SELECT domain, step_num, status AS step_status, step_name, message
         FROM (
           SELECT
             domain, step_num, status, step_name, message,
             ROW_NUMBER() OVER (
               PARTITION BY domain
               ORDER BY
                 CASE status
                   WHEN 'running'   THEN 0
                   WHEN 'failed'    THEN 1
                   WHEN 'warning'   THEN 1
                   WHEN 'completed' THEN 2
                   WHEN 'skipped'   THEN 3
                   ELSE 4
                 END,
                 step_num DESC
             ) AS rn
           FROM step_tracker
           WHERE domain IN (${placeholders})
         )
        WHERE rn = 1`,
      ...args,
    )
    currentSteps = new Map(rows.map((r) => [r.domain, r]))
  }

  const enriched = domains.map((d) => {
    const cs = currentSteps.get(d.domain)
    return {
      ...d,
      current_step: cs?.step_num ?? 0,
      current_step_status: cs?.step_status ?? null,
      current_step_name: cs?.step_name ?? null,
      current_step_message: cs?.message ?? null,
    }
  })

  return NextResponse.json({
    domains: enriched,
    bulk_list_mode: tokens.length > 1,
    bulk_match_count: tokens.length > 1 ? enriched.length : null,
  })
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null)
  const raw = (form?.get("domains") as string | null) || ""
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null

  const candidates = raw.replace(/,/g, "\n").split("\n").map((d) => d.trim()).filter(Boolean)
  const valid = candidates.map(validate).filter((d): d is string => d !== null)
  for (const d of valid) addDomain(d)
  const skipped = candidates.length - valid.length

  if (valid.length) {
    appendAudit("domain_add", `${valid.length} domains`, valid.slice(0, 5).join(", "), ip)
  }
  return NextResponse.json({ ok: true, count: valid.length, skipped })
}
