import { NextResponse, type NextRequest } from "next/server"
import { one } from "@/lib/db"
import { appendAudit } from "@/lib/repos/audit"
import { logPipeline } from "@/lib/repos/logs"
import crypto from "node:crypto"

export const runtime = "nodejs"

const CF_API = "https://api.cloudflare.com/client/v4"

interface KeyCreds {
  email: string
  api_key: string
  cf_account_id: string | null
  alias: string | null
}

interface CfZoneCreateResponse {
  success?: boolean
  errors?: { code: number; message: string }[]
  result?: {
    id: string
    name: string
    name_servers?: string[]
    status?: string
  }
}

interface CfZoneDeleteResponse {
  success?: boolean
  errors?: { code: number; message: string }[]
}

/**
 * Diagnostic: create a throwaway zone using this CF key's creds, capture
 * the zone_id + nameservers CF returns, then immediately delete it. Confirms
 * end-to-end that the (email, api_key, cf_account_id) triple can actually
 * mint zones — useful when the operator suspects a key is broken or wants
 * to verify "do new domains really get unique zone_ids?" without touching
 * a real domain.
 *
 * Uses a name like `cf-zone-test-<unix>-<16hex>.com` — `.example` would be
 * cleaner (RFC 2606 reserved) but CF rejects it with error 1099 ("not a
 * registered domain") because they verify the TLD against IANA's registered
 * list. `.com` is real, so CF accepts it. CF doesn't verify domain ownership
 * at zone-create time (only at activation), and 64 bits of randomness make
 * collision with a real domain astronomically unlikely. Even on collision the
 * delete is scoped to OUR account, so it can never affect another tenant.
 *
 * Side effects:
 *   - Logs to pipeline_log under `(test-cf-zone)` channel
 *   - Audit-logged
 *   - The temp zone is deleted before the response returns; if delete fails,
 *     the response includes the orphan zone_id so the operator can clean up.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const keyId = Number.parseInt(id, 10)
  if (!Number.isFinite(keyId)) {
    return NextResponse.json({ ok: false, error: "invalid key id" }, { status: 400 })
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null

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
      error: "cf_account_id is missing on this key — run 'Refresh accounts' first",
    }, { status: 400 })
  }

  const headers = {
    "X-Auth-Email": row.email,
    "X-Auth-Key": row.api_key,
    "Content-Type": "application/json",
  }

  const stamp = Math.floor(Date.now() / 1000)
  const rand = crypto.randomBytes(8).toString("hex")
  const testName = `cf-zone-test-${stamp}-${rand}.com`
  const channel = `(test-cf-zone-${keyId})`

  logPipeline(channel, "test_create_zone", "running",
    `POST /zones name=${testName} account=${row.cf_account_id.slice(0, 12)}…`)

  // 1. Create
  let createBody: CfZoneCreateResponse
  let createStatus: number
  try {
    const res = await fetch(`${CF_API}/zones`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: testName,
        account: { id: row.cf_account_id },
        type: "full",
        jump_start: false,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    createStatus = res.status
    const text = await res.text()
    try {
      createBody = JSON.parse(text) as CfZoneCreateResponse
    } catch {
      logPipeline(channel, "test_create_zone", "failed",
        `Non-JSON response (HTTP ${createStatus}): ${text.slice(0, 200)}`)
      return NextResponse.json({
        ok: false,
        error: `CF returned non-JSON (HTTP ${createStatus})`,
        body: text.slice(0, 500),
      }, { status: 502 })
    }
  } catch (e) {
    const msg = `Network/timeout: ${(e as Error).message}`
    logPipeline(channel, "test_create_zone", "failed", msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }

  if (!createBody.success || !createBody.result) {
    const errMsg = createBody.errors?.map((e) => `${e.code}:${e.message}`).join("; ")
      ?? `HTTP ${createStatus}`
    logPipeline(channel, "test_create_zone", "failed", `CF rejected create: ${errMsg}`)
    appendAudit("cf_test_zone", String(keyId),
      `failed name=${testName} err=${errMsg.slice(0, 200)}`, ip)
    return NextResponse.json({
      ok: false,
      stage: "create",
      error: `Cloudflare rejected zone create: ${errMsg}`,
      key_alias: row.alias,
      test_zone_name: testName,
    }, { status: 502 })
  }

  const zoneId = createBody.result.id
  const nameservers = createBody.result.name_servers ?? []
  const zoneStatus = createBody.result.status ?? "unknown"
  logPipeline(channel, "test_create_zone", "completed",
    `Zone CREATED zone_id=${zoneId} ns=${nameservers.join(",")} status=${zoneStatus}`)

  // 2. Delete (cleanup)
  let deleteOk = false
  let deleteError: string | null = null
  try {
    const res = await fetch(`${CF_API}/zones/${zoneId}`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    let body: CfZoneDeleteResponse | null = null
    try { body = JSON.parse(text) as CfZoneDeleteResponse } catch { /* ignore */ }
    deleteOk = res.ok && (body?.success ?? false)
    if (!deleteOk) {
      deleteError = body?.errors?.map((e) => `${e.code}:${e.message}`).join("; ")
        ?? `HTTP ${res.status}`
    }
  } catch (e) {
    deleteError = `Network/timeout on delete: ${(e as Error).message}`
  }

  if (deleteOk) {
    logPipeline(channel, "test_create_zone", "completed",
      `Cleanup DELETE ok — zone ${zoneId} removed`)
  } else {
    logPipeline(channel, "test_create_zone", "warning",
      `Cleanup DELETE FAILED (${deleteError ?? "unknown"}) — orphan zone_id=${zoneId}`)
  }

  appendAudit("cf_test_zone", String(keyId),
    `ok name=${testName} zone_id=${zoneId} delete_ok=${deleteOk}`, ip)

  return NextResponse.json({
    ok: true,
    key_alias: row.alias,
    test_zone_name: testName,
    zone_id: zoneId,
    nameservers,
    initial_status: zoneStatus,
    cleanup: {
      deleted: deleteOk,
      error: deleteError,
      orphan_zone_id: deleteOk ? null : zoneId,
    },
    message: deleteOk
      ? `✓ Zone create + cleanup OK · zone_id=${zoneId.slice(0, 12)}… · NS=${nameservers.join(", ")}`
      : `✓ Zone CREATE worked (zone_id=${zoneId}) but cleanup FAILED — delete it manually in CF: ${deleteError}`,
  })
}
