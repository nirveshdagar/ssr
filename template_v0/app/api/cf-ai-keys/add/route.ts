import { NextResponse, type NextRequest } from "next/server"
import { addCfAiKey } from "@/lib/repos/cf-ai-keys"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Add a Workers AI (account_id, api_token) pair to the pool. Live-verifies
 * by hitting `/accounts/{id}/ai/models/search` before insert so a malformed
 * pair never reaches the pool.
 *
 * The token must have the Workers AI Read scope on the named account; we
 * surface the CF error verbatim if it doesn't.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ipAddr = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const accountId = ((form?.get("account_id") as string | null) || "").trim()
  const apiToken = ((form?.get("api_token") as string | null) || "").trim()
  const alias = ((form?.get("alias") as string | null) || "").trim() || null
  if (!accountId || !apiToken) {
    return NextResponse.json(
      { ok: false, error: "Both account_id and api_token are required" },
      { status: 400 },
    )
  }
  // Verify before insert
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=1`,
      {
        headers: { Authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (r.status !== 200) {
      return NextResponse.json({
        ok: false,
        error: `CF rejected the credentials (${r.status}): ${(await r.text()).slice(0, 240)}`,
      }, { status: 400 })
    }
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: `Could not verify credentials: ${(e as Error).message}`,
    }, { status: 502 })
  }
  try {
    const newId = addCfAiKey({ accountId, apiToken, alias })
    appendAudit(
      "cf_ai_key_add",
      String(newId),
      `account=${accountId.slice(0, 6)}... alias=${alias ?? ""}`,
      ipAddr,
    )
    return NextResponse.json({
      ok: true,
      id: newId,
      message: `Added Workers AI pool row #${newId}${alias ? ` (${alias})` : ""}`,
    })
  } catch (e) {
    const m = (e as Error).message
    if (/already in the pool/.test(m)) {
      return NextResponse.json({ ok: false, error: m }, { status: 409 })
    }
    return NextResponse.json({ ok: false, error: `Failed to add: ${m}` }, { status: 500 })
  }
}
