import { NextResponse, type NextRequest } from "next/server"
import { addCfKey } from "@/lib/cf-key-pool"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Add a CF Global API Key to the pool. Live-verifies via `/accounts` before
 * inserting so a broken key never reaches the pool. Auto-extracts the real
 * cf_account_id (NOT the user id, which is what /user returns and is the
 * source of the legacy "wrong account_id" bug).
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ipAddr = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const email = ((form?.get("email") as string | null) || "").trim()
  const apiKey = ((form?.get("api_key") as string | null) || "").trim()
  const alias = ((form?.get("alias") as string | null) || "").trim() || null
  if (!email || !apiKey) {
    return NextResponse.json({ ok: false, error: "Email and API key are required" }, { status: 400 })
  }
  // Verify via /accounts
  let acctId = ""
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/accounts", {
      headers: {
        "X-Auth-Email": email,
        "X-Auth-Key": apiKey,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (r.status !== 200) {
      return NextResponse.json({
        ok: false,
        error: `CF rejected the key (${r.status}): ${(await r.text()).slice(0, 200)}`,
      }, { status: 400 })
    }
    const j = (await r.json()) as { result?: { id?: string }[] }
    const accts = j.result ?? []
    if (accts.length === 0) {
      return NextResponse.json({
        ok: false,
        error: "CF auth ok but no accounts returned — is billing set up on this CF account?",
      }, { status: 400 })
    }
    acctId = accts[0].id ?? ""
  } catch (e) {
    return NextResponse.json({
      ok: false, error: `Could not verify CF key: ${(e as Error).message}`,
    }, { status: 502 })
  }
  try {
    const newId = addCfKey({ email, apiKey, alias, cfAccountId: acctId })
    appendAudit("cf_key_add", String(newId), `email=${email} alias=${alias ?? ""}`, ipAddr)
    return NextResponse.json({
      ok: true, id: newId, message: `Added CF key #${newId} (${alias ?? email}) to pool`,
    })
  } catch (e) {
    const m = (e as Error).message
    if (/already exists/.test(m)) {
      return NextResponse.json({ ok: false, error: m }, { status: 409 })
    }
    return NextResponse.json({ ok: false, error: `Failed to add key: ${m}` }, { status: 500 })
  }
}
