import { NextResponse, type NextRequest } from "next/server"
import { refreshAllCfAccountIds } from "@/lib/cf-key-pool"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/** Re-fetch real account_id from /accounts for every CF key, persist + report. */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const results = await refreshAllCfAccountIds()
  const changed = results.filter((r) => r.changed).length
  const errored = results.filter((r) => r.error).length
  appendAudit("cf_keys_refresh_accounts", "",
    `total=${results.length} changed=${changed} errored=${errored}`, ip)
  return NextResponse.json({
    ok: true,
    summary: { total: results.length, changed, errored },
    results,
  })
}
