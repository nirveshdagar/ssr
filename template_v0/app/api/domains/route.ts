import { NextResponse, type NextRequest } from "next/server"
import { addDomain, listDomains } from "@/lib/repos/domains"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

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

  return NextResponse.json({
    domains,
    bulk_list_mode: tokens.length > 1,
    bulk_match_count: tokens.length > 1 ? domains.length : null,
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
