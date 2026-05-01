import { NextResponse, type NextRequest } from "next/server"
import { probeKeyDomains, type KeyProbeSummary } from "@/lib/cf-key-probe"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

const MAX_BULK = 200
// 4 keys at a time keeps the worst-case time bounded for 200 selected keys
// (200 keys × 20 domains avg ÷ 4 parallel ÷ 20 internal workers ≈ 20s) while
// avoiding hundreds of concurrent TCP fan-outs from one box to CF's edge.
const KEY_PARALLELISM = 4

/**
 * Bulk variant of /api/cf-keys/[id]/refresh-status — accepts JSON
 * { ids: number[] } and probes domains across all selected keys. Useful
 * when an operator just edited a batch of keys (max_domains, alias) and
 * wants live-status for those keys only without burning calls on the
 * other 450.
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

  // Process keys with bounded parallelism — each key's internal probe
  // already has its own 20-worker pool, so KEY_PARALLELISM is the outer
  // cap on concurrent keys-in-flight.
  const summaries = new Array<KeyProbeSummary>(ids.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= ids.length) return
      try {
        summaries[i] = await probeKeyDomains(ids[i])
      } catch (e) {
        summaries[i] = {
          key_id: ids[i], count: 0, flipped: 0, errored: 0,
          results: [{
            domain: "", before: "", after: "",
            http_status: null, error: (e as Error).message.slice(0, 200),
          }],
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(KEY_PARALLELISM, ids.length) }, () => worker()),
  )

  const totalDomains = summaries.reduce((acc, s) => acc + s.count, 0)
  const totalFlipped = summaries.reduce((acc, s) => acc + s.flipped, 0)
  const totalErrored = summaries.reduce((acc, s) => acc + s.errored, 0)

  appendAudit("cf_key_bulk_refresh_status", "",
    `keys=${ids.length} domains=${totalDomains} flipped=${totalFlipped} errored=${totalErrored}`,
    ip)

  return NextResponse.json({
    ok: true,
    keys_probed: ids.length,
    domains_probed: totalDomains,
    flipped: totalFlipped,
    errored: totalErrored,
    summaries,
    message:
      `Probed ${totalDomains} domain(s) across ${ids.length} key(s); flipped ${totalFlipped}` +
      (totalErrored > 0 ? `, ${totalErrored} errored` : ""),
  })
}
