import { NextResponse, type NextRequest } from "next/server"
import { getDomain, updateDomain, type DomainRow } from "@/lib/repos/domains"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Whitelist of overridable domain columns + per-field byte caps. Mirrors
 * Flask's _OVERRIDABLE_DOMAIN_COLS exactly.
 */
const OVERRIDABLE: Record<string, number> = {
  site_html:        1 * 1024 * 1024,    // step 9 output: paste your own PHP
  status:           64,                 // any step: nudge state machine
  cf_zone_id:       128,                // step 3: BYO zone
  cf_nameservers:   1024,               // step 3: BYO NS
  cf_email:         255,                // step 2 manual
  cf_global_key:    1024,               // step 2 manual
  current_proxy_ip: 64,                 // step 7
  origin_cert_pem:  16 * 1024,          // step 8 BYO cert
  origin_key_pem:   16 * 1024,          // step 8 BYO key
}

const ALLOWED = new Set(Object.keys(OVERRIDABLE))

/**
 * Override one whitelisted domain column with a manual value. Used by the
 * step console's "Override" button when an automated step keeps failing or
 * the operator wants to substitute a hand-written value.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ domain: string }> },
): Promise<Response> {
  const { domain } = await params
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const field = ((form?.get("field") as string | null) || "").trim()
  const value = (form?.get("value") as string | null) ?? ""

  if (!ALLOWED.has(field)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Field '${field}' not overridable. Allowed: ${[...ALLOWED].sort().join(", ")}`,
      },
      { status: 400 },
    )
  }
  const cap = OVERRIDABLE[field]
  const valueBytes = Buffer.byteLength(value, "utf8")
  if (valueBytes > cap) {
    return NextResponse.json(
      {
        ok: false,
        error: `Value too large for ${field}: ${valueBytes} bytes > ${cap}-byte cap. Nothing was written.`,
      },
      { status: 413 },
    )
  }

  const prev = getDomain(domain)
  const prevVal = prev ? ((prev as unknown as Record<string, string | null>)[field] ?? "") : ""
  const prevLen = prevVal ? prevVal.length : 0
  // updateDomain's whitelist DOES include all of these — guarded above too
  updateDomain(domain, { [field]: value } as Partial<DomainRow>)
  appendAudit(
    "domain_override", domain,
    `field=${field} old_len=${prevLen} new_len=${value.length}`,
    ip,
  )
  return NextResponse.json({
    ok: true,
    message: `Override saved: ${domain}.${field} (prev=${prevLen} chars, new=${value.length} chars)`,
    field,
    prev_len: prevLen,
    new_len: value.length,
  })
}
