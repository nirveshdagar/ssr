import { NextResponse, type NextRequest } from "next/server"
import { refreshCfAccountId } from "@/lib/cf-key-pool"
import { setCfKeyLastError } from "@/lib/repos/cf-keys"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

const MAX_BULK = 200
const KEY_PARALLELISM = 4

interface VerifyResult {
  id: number
  before: string
  after: string
  changed: boolean
  error: string | null
}

/**
 * Scoped variant of /api/cf-keys/refresh-accounts. Re-fetches CF /accounts
 * for ONLY the passed ids and persists the real account_id (+ propagates
 * to all domains assigned to the key). Failures are recorded in the
 * cf_keys.last_error column so they show up in the Issues column without
 * the operator needing to inspect the response.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null

  let ids: number[] = []
  try {
    const body = (await req.json()) as { ids?: unknown }
    if (!Array.isArray(body.ids)) {
      return NextResponse.json({ ok: false, error: "ids[] required" }, { status: 400 })
    }
    ids = body.ids
      .map((v) => Number.parseInt(String(v), 10))
      .filter((n) => Number.isFinite(n) && n > 0)
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `parse failed: ${(e as Error).message}` },
      { status: 400 },
    )
  }

  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "no valid ids provided" }, { status: 400 })
  }
  if (ids.length > MAX_BULK) {
    return NextResponse.json(
      { ok: false, error: `too many ids (${ids.length} > ${MAX_BULK})` },
      { status: 413 },
    )
  }

  const results = new Array<VerifyResult>(ids.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= ids.length) return
      const id = ids[i]
      try {
        const after = await refreshCfAccountId(id)
        // refreshCfAccountId doesn't return `before` so we treat changed=true
        // as "we wrote a new value" for telemetry purposes.
        results[i] = {
          id, before: "", after,
          changed: true, error: null,
        }
        setCfKeyLastError(id, null)
      } catch (e) {
        const msg = (e as Error).message
        results[i] = { id, before: "", after: "", changed: false, error: msg }
        setCfKeyLastError(id, `verify-accounts failed: ${msg}`)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(KEY_PARALLELISM, ids.length) }, () => worker()),
  )

  const ok_count = results.filter((r) => r.error === null).length
  const errored = results.length - ok_count

  appendAudit("cf_key_bulk_verify_accounts", "",
    `keys=${ids.length} ok=${ok_count} errored=${errored}`, ip)

  return NextResponse.json({
    ok: true,
    submitted: ids.length,
    verified: ok_count,
    errored,
    results,
    message:
      `Verified ${ok_count}/${ids.length} CF key(s)` +
      (errored > 0 ? `, ${errored} errored (see Issues column)` : ""),
  })
}
