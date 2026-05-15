import { NextResponse, type NextRequest } from "next/server"
import {
  applyAliasPattern,
  bulkEditCfKeys,
} from "@/lib/repos/cf-keys"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

const MAX_BULK = 1000

/**
 * Bulk edit CF pool keys. Accepts JSON body:
 *   {
 *     ids:           number[],            // required
 *     max_domains?:  number,              // optional, 1..1000
 *     is_active?:    0 | 1,               // optional, 0 = pause / 1 = activate
 *     alias_pattern?: string,             // optional, supports {n} and {n:03}
 *     alias_start?:   number,             // default 1, where the {n} counter starts
 *   }
 *
 * At least one of (max_domains, is_active, alias_pattern) must be provided.
 *
 * Pattern examples:
 *   "CF-{n}"        → CF-1, CF-2, CF-3, …
 *   "CF-{n:03}"     → CF-001, CF-002, CF-003, …
 *   "pool-a-{n:02}" → pool-a-01, pool-a-02, …
 *
 * All updates run inside a single IMMEDIATE transaction (see bulkEditCfKeys)
 * so a partial failure doesn't leave half the rows renumbered.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null

  let body: {
    ids?: unknown
    max_domains?: unknown
    is_active?: unknown
    alias_pattern?: unknown
    alias_start?: unknown
  }
  try {
    body = await req.json() as typeof body
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `parse failed: ${(e as Error).message}` },
      { status: 400 },
    )
  }

  if (!Array.isArray(body.ids)) {
    return NextResponse.json({ ok: false, error: "ids[] required" }, { status: 400 })
  }
  const ids = body.ids
    .map((v) => Number.parseInt(String(v), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "no valid ids provided" }, { status: 400 })
  }
  if (ids.length > MAX_BULK) {
    return NextResponse.json(
      { ok: false, error: `too many ids (${ids.length} > ${MAX_BULK})` },
      { status: 413 },
    )
  }

  // Coerce + validate the optional fields
  let maxDomains: number | undefined
  if (body.max_domains !== undefined && body.max_domains !== null && body.max_domains !== "") {
    maxDomains = Number.parseInt(String(body.max_domains), 10)
    if (!Number.isFinite(maxDomains) || maxDomains < 1 || maxDomains > 1000) {
      return NextResponse.json(
        { ok: false, error: "max_domains must be an integer 1..1000" },
        { status: 400 },
      )
    }
  }

  let isActive: 0 | 1 | undefined
  if (body.is_active !== undefined && body.is_active !== null && body.is_active !== "") {
    const n = Number.parseInt(String(body.is_active), 10)
    if (n !== 0 && n !== 1) {
      return NextResponse.json(
        { ok: false, error: "is_active must be 0 or 1" },
        { status: 400 },
      )
    }
    isActive = n as 0 | 1
  }

  let aliases: (string | null)[] | undefined
  let pattern: string | undefined
  if (body.alias_pattern !== undefined && body.alias_pattern !== null && String(body.alias_pattern).trim() !== "") {
    pattern = String(body.alias_pattern).trim()
    if (pattern.length > 80) {
      return NextResponse.json(
        { ok: false, error: "alias_pattern must be ≤ 80 chars" },
        { status: 400 },
      )
    }
    let start = 1
    if (body.alias_start !== undefined && body.alias_start !== null && body.alias_start !== "") {
      start = Number.parseInt(String(body.alias_start), 10)
      if (!Number.isFinite(start) || start < 0 || start > 999_999) {
        return NextResponse.json(
          { ok: false, error: "alias_start must be 0..999999" },
          { status: 400 },
        )
      }
    }
    aliases = applyAliasPattern(pattern, ids.length, start)
  }

  if (maxDomains === undefined && isActive === undefined && aliases === undefined) {
    return NextResponse.json(
      { ok: false, error: "Pass at least one of max_domains, is_active, alias_pattern" },
      { status: 400 },
    )
  }

  const result = bulkEditCfKeys({
    ids,
    alias: aliases,
    max_domains: maxDomains,
    is_active: isActive,
  })

  const detail = [
    pattern && `pattern="${pattern}"`,
    maxDomains !== undefined && `max=${maxDomains}`,
    isActive !== undefined && `is_active=${isActive}`,
    `ids=${ids.length}`,
    `updated=${result.updated}`,
    result.missing.length > 0 && `missing=${result.missing.length}`,
  ].filter(Boolean).join(" ")
  appendAudit("cf_key_bulk_edit", "", detail, ip)

  return NextResponse.json({
    ok: true,
    submitted: ids.length,
    updated: result.updated,
    missing: result.missing,
    message:
      `Updated ${result.updated}/${ids.length} CF key(s)` +
      (result.missing.length > 0 ? ` (${result.missing.length} not found)` : ""),
    sample_aliases: aliases ? aliases.slice(0, 3) : undefined,
  })
}
