import { NextResponse, type NextRequest } from "next/server"
import { one, all } from "@/lib/db"

export const runtime = "nodejs"

const CF_API = "https://api.cloudflare.com/client/v4"

interface KeyCreds {
  email: string
  api_key: string
  cf_account_id: string | null
  alias: string | null
}

interface CfZone {
  id: string
  name: string
  status: string
  paused?: boolean
  type?: string
  created_on?: string
  modified_on?: string
}

interface CfZonesResponse {
  success?: boolean
  errors?: { code: number; message: string }[]
  result?: CfZone[]
}

/**
 * Live list of every zone CF reports for this key's account, joined against
 * SSR's `domains` table. Each zone gets a `tracked` flag so the operator
 * can spot:
 *   - SSR rows whose CF zone is gone (tracked=true, in_cf=false)
 *   - CF zones SSR doesn't know about (tracked=false, in_cf=true)
 *
 * Read-only — never mutates DB or CF state.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const keyId = Number.parseInt(id, 10)
  if (!Number.isFinite(keyId)) {
    return NextResponse.json({ ok: false, error: "invalid key id" }, { status: 400 })
  }

  const row = one<KeyCreds>(
    "SELECT email, api_key, cf_account_id, alias FROM cf_keys WHERE id = ?",
    keyId,
  )
  if (!row) {
    return NextResponse.json({ ok: false, error: "Key not found" }, { status: 404 })
  }
  if (!row.cf_account_id) {
    return NextResponse.json({
      ok: false,
      error: "cf_account_id missing — run 'Refresh accounts' first",
    }, { status: 400 })
  }

  // Fetch all zones for this account (paginated; CF caps at 50/page).
  const zones: CfZone[] = []
  let page = 1
  while (page < 100) {
    const url = `${CF_API}/zones?account.id=${encodeURIComponent(row.cf_account_id)}` +
      `&per_page=50&page=${page}`
    const res = await fetch(url, {
      headers: {
        "X-Auth-Email": row.email,
        "X-Auth-Key": row.api_key,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      const txt = await res.text()
      return NextResponse.json({
        ok: false,
        error: `CF API HTTP ${res.status}: ${txt.slice(0, 300)}`,
      }, { status: 502 })
    }
    const body = (await res.json()) as CfZonesResponse
    if (!body.success) {
      const errMsg = body.errors?.map((e) => `${e.code}:${e.message}`).join("; ") ?? "unknown"
      return NextResponse.json({
        ok: false,
        error: `CF rejected: ${errMsg}`,
      }, { status: 502 })
    }
    const got = body.result ?? []
    zones.push(...got)
    if (got.length < 50) break
    page++
  }

  // Cross-reference against SSR's domains table.
  const tracked = new Map<string, { domain: string; cf_zone_id: string | null; status: string }>()
  for (const r of all<{ domain: string; cf_zone_id: string | null; status: string }>(
    "SELECT domain, cf_zone_id, status FROM domains WHERE cf_key_id = ?", keyId,
  )) {
    tracked.set(r.domain.toLowerCase(), r)
  }

  const enriched = zones.map((z) => {
    const t = tracked.get(z.name.toLowerCase())
    return {
      cf_zone_id: z.id,
      name: z.name,
      cf_status: z.status,
      cf_type: z.type ?? null,
      cf_paused: !!z.paused,
      cf_created: z.created_on ?? null,
      tracked: !!t,
      ssr_domain_status: t?.status ?? null,
      ssr_zone_id_match: t ? (t.cf_zone_id === z.id) : null,
    }
  })

  // Find SSR rows whose zone CF doesn't know about
  const cfNames = new Set(zones.map((z) => z.name.toLowerCase()))
  const trackedMissing = Array.from(tracked.values())
    .filter((t) => !cfNames.has(t.domain.toLowerCase()))
    .map((t) => ({
      domain: t.domain,
      cf_zone_id: t.cf_zone_id,
      ssr_status: t.status,
      reason: "SSR has cf_zone_id but CF doesn't list this zone for the account",
    }))

  return NextResponse.json({
    ok: true,
    key_alias: row.alias,
    cf_account_id: row.cf_account_id,
    zones: enriched,
    tracked_missing_in_cf: trackedMissing,
    total_in_cf: zones.length,
    total_tracked: tracked.size,
  })
}
