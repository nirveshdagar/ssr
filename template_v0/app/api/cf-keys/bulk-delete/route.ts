import { NextResponse, type NextRequest } from "next/server"
import { deleteCfKey, getCfKey } from "@/lib/repos/cf-keys"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

const MAX_BULK = 1000

interface ResultRow {
  id: number
  email?: string | null
  alias?: string | null
  ok: boolean
  reason?: string
}

/**
 * Bulk delete CF pool keys. Accepts JSON body { ids: [number, ...] } OR
 * FormData with repeated `ids` fields. Per-row, calls deleteCfKey which
 * REFUSES if any domain still references the key (so you can't strand
 * domains by yanking a key out from under them). Per-row failures don't
 * abort the rest — operator gets a per-row report.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null

  let ids: number[] = []
  const ct = req.headers.get("content-type") ?? ""
  try {
    if (ct.includes("application/json")) {
      const body = (await req.json()) as { ids?: unknown }
      if (!Array.isArray(body.ids)) {
        return NextResponse.json({ ok: false, error: "expected JSON body { ids: [...] }" }, { status: 400 })
      }
      ids = body.ids
        .map((v) => Number.parseInt(String(v), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
    } else {
      const form = await req.formData()
      ids = form.getAll("ids")
        .map((v) => Number.parseInt(String(v), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
    }
  } catch (e) {
    return NextResponse.json({ ok: false, error: `parse failed: ${(e as Error).message}` }, { status: 400 })
  }

  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "no ids provided" }, { status: 400 })
  }
  if (ids.length > MAX_BULK) {
    return NextResponse.json(
      { ok: false, error: `too many ids (${ids.length} > ${MAX_BULK})` },
      { status: 413 },
    )
  }

  const results: ResultRow[] = []
  for (const id of ids) {
    const row = getCfKey(id)
    if (!row) {
      results.push({ id, ok: false, reason: "not found" })
      continue
    }
    const r = deleteCfKey(id)
    results.push({
      id, email: row.email, alias: row.alias,
      ok: r.ok, reason: r.reason,
    })
  }

  const deleted = results.filter((r) => r.ok).length
  const blocked = results.length - deleted
  appendAudit(
    "cf_key_bulk_delete", "",
    `submitted=${ids.length} deleted=${deleted} blocked=${blocked}`,
    ip,
  )
  return NextResponse.json({
    ok: true,
    submitted: ids.length,
    deleted,
    blocked,
    results,
    message:
      `Deleted ${deleted}/${ids.length} CF key(s)` +
      (blocked > 0
        ? `; ${blocked} blocked (had domain references — soft-delete those domains first)`
        : ""),
  })
}
