import { NextResponse, type NextRequest } from "next/server"
import { all } from "@/lib/db"
import {
  listApplications,
  verifyOriginCertIsCustom,
  pushSaUiTracker,
} from "@/lib/serveravatar"
import { setDnsARecord, setDnsARecordWww } from "@/lib/cloudflare"
import { logPipeline } from "@/lib/repos/logs"
import { appendAudit } from "@/lib/repos/audit"
import { clientIp } from "@/lib/request-ip"

export const runtime = "nodejs"

interface DomainResult {
  domain: string
  status: "ok" | "skip" | "regressed" | "inconclusive" | "error"
  sa_ssl_before?: string | null
  sa_ssl_after?: string | null
  verify_msg?: string
  reason?: string
}

/**
 * "Push cert to SA UI" sweep — make SA's dashboard panel show
 * `Custom · CloudFlare Origin · Force HTTPS ON` for every domain whose
 * origin cert is already verified (`ssl_origin_ok=1` in our DB).
 *
 * Handles both states cleanly (the previous version only worked for
 * apps with non-null `app.ssl` — null-state hit SA's state-lock bug):
 *
 *   - **app.ssl != null** (apps with prior LE/auto state) →
 *       DELETE /ssl → POST /ssl custom → toggle force-https.
 *   - **app.ssl == null** (fresh apps SA never auto-issued for) →
 *       grey-cloud → POST /ssl automatic (prime LE state with one
 *       retry on transient 500) → DELETE → POST custom → toggle →
 *       orange-cloud restore. Calls `pushSaUiTracker` so the recipe
 *       stays single-sourced.
 *
 * Body (optional JSON): `{ domains: string[] }` to limit to a subset.
 * Empty body / no body = run across the entire eligible fleet
 * (`ssl_origin_ok=1` + status hosted/live/ssl_installed).
 *
 * Safe to re-run. The DNS proxied-flag flip is wrapped in a try/finally
 * so a thrown error mid-sync still restores orange-cloud.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = clientIp(req)
  const body = (await req.json().catch(() => ({}))) as { domains?: unknown }
  const explicit = Array.isArray(body.domains)
    ? body.domains.filter((d): d is string => typeof d === "string" && d.length > 0)
    : []

  const rows = all<{
    domain: string
    ssl_origin_ok: number | null
    server_id: number | null
    server_ip: string | null
    sa_server_id: string | null
    origin_cert_pem: string | null
    origin_key_pem: string | null
  }>(
    `SELECT d.domain, d.ssl_origin_ok, d.server_id,
            d.origin_cert_pem, d.origin_key_pem,
            s.ip AS server_ip, s.sa_server_id
       FROM domains d JOIN servers s ON s.id = d.server_id
      WHERE ${explicit.length > 0
        ? `d.domain IN (${explicit.map(() => "?").join(",")})`
        : `d.ssl_origin_ok = 1 AND d.status IN ('hosted','live','ssl_installed')`}
      ORDER BY d.domain`,
    ...explicit,
  )

  const results: DomainResult[] = []

  for (const r of rows) {
    if (explicit.length === 0 && r.ssl_origin_ok !== 1) {
      results.push({ domain: r.domain, status: "skip",
        reason: `ssl_origin_ok=${r.ssl_origin_ok} (cert not verified — leave alone)` })
      continue
    }
    if (!r.sa_server_id || !r.server_ip) {
      results.push({ domain: r.domain, status: "skip",
        reason: "no sa_server_id or server_ip on linked server" })
      continue
    }
    if (!r.origin_cert_pem || !r.origin_key_pem) {
      results.push({ domain: r.domain, status: "skip",
        reason: "no cached CF Origin cert+key on domain row (run step 8 once first)" })
      continue
    }

    // Find SA app id
    let appId: string
    let saSslBefore: string | null = null
    try {
      const apps = await listApplications(r.sa_server_id)
      const match = apps.find(
        (a) =>
          (a.primary_domain ?? "").toLowerCase() === r.domain.toLowerCase() ||
          (a.name ?? "").toLowerCase().includes(r.domain.replace(/\./g, "-").toLowerCase()),
      )
      if (!match) {
        results.push({ domain: r.domain, status: "error",
          reason: `app not found on SA server ${r.sa_server_id}` })
        continue
      }
      appId = String(match.id)
      saSslBefore = (match.ssl ?? null) as string | null
    } catch (e) {
      results.push({ domain: r.domain, status: "error",
        reason: `listApplications: ${(e as Error).message.slice(0, 120)}` })
      continue
    }

    const sslPath =
      `/organizations/{ORG_ID}/servers/${r.sa_server_id}` +
      `/applications/${appId}/ssl`

    // Run the same recipe pipeline step 8 uses. For null-state apps, this
    // requires a grey-cloud window so SA's auto-LE HTTP-01 challenge can
    // reach origin. For non-null state, the recipe short-circuits at step
    // 1 ("already custom + CF Origin → nothing to do") or skips the prime
    // and goes straight to DELETE + POST custom. Either way we own the
    // DNS state for the duration so the caller never sees grey-cloud leak
    // past return.
    let greyClouded = false
    try {
      if (saSslBefore !== "custom") {
        logPipeline(r.domain, "sa_clear_le", "running",
          "Grey-clouding A + WWW for SA auto-LE verification...")
        await setDnsARecord(r.domain, r.server_ip, false)
        await setDnsARecordWww(r.domain, r.server_ip, false)
        greyClouded = true
        // 30s for CF edge to propagate. Same constant as step 8.
        await new Promise((res) => setTimeout(res, 30_000))
      }

      await pushSaUiTracker(sslPath, {
        saServerId: r.sa_server_id,
        appId,
        certificatePem: r.origin_cert_pem,
        privateKeyPem: r.origin_key_pem,
        chainPem: "",
        forceHttps: true,
        domain: r.domain,
        serverIp: r.server_ip,
      })
    } catch (e) {
      results.push({ domain: r.domain, status: "error",
        reason: `pushSaUiTracker threw: ${(e as Error).message.slice(0, 160)}` })
      // fall through to orange-cloud restore + verification
    } finally {
      if (greyClouded) {
        try {
          await setDnsARecord(r.domain, r.server_ip, true)
          await setDnsARecordWww(r.domain, r.server_ip, true)
        } catch (e) {
          logPipeline(r.domain, "sa_clear_le", "warning",
            `Could not re-enable proxy after sync: ${(e as Error).message.slice(0, 160)}`)
        }
      }
    }

    // Re-verify cert on the wire is still CF Origin CA.
    try {
      const v = await verifyOriginCertIsCustom(r.server_ip, r.domain, 10_000)
      // Re-read tracker so the response carries the after-state.
      let saSslAfter: string | null = null
      try {
        const apps2 = await listApplications(r.sa_server_id)
        const match2 = apps2.find(
          (a) => (a.primary_domain ?? "").toLowerCase() === r.domain.toLowerCase(),
        )
        saSslAfter = (match2?.ssl ?? null) as string | null
      } catch { /* best-effort */ }

      if (v.ok === true) {
        results.push({ domain: r.domain, status: "ok",
          sa_ssl_before: saSslBefore, sa_ssl_after: saSslAfter,
          verify_msg: v.message })
        logPipeline(r.domain, "sa_clear_le", "completed",
          `Tracker synced (was=${saSslBefore ?? "null"} now=${saSslAfter ?? "null"}); ` +
          `cert ${v.message}`)
      } else if (v.ok === false) {
        results.push({ domain: r.domain, status: "regressed",
          sa_ssl_before: saSslBefore, sa_ssl_after: saSslAfter,
          verify_msg: v.message })
        logPipeline(r.domain, "sa_clear_le", "failed",
          `Tracker sync attempted BUT cert regressed: ${v.message}. Auto-heal will re-run step 8.`)
      } else {
        results.push({ domain: r.domain, status: "inconclusive",
          sa_ssl_before: saSslBefore, sa_ssl_after: saSslAfter,
          verify_msg: v.message })
        logPipeline(r.domain, "sa_clear_le", "warning",
          `Tracker sync attempted; cert verify inconclusive: ${v.message}`)
      }
    } catch (e) {
      results.push({ domain: r.domain, status: "inconclusive",
        verify_msg: `probe threw: ${(e as Error).message.slice(0, 120)}` })
    }
  }

  const tally = {
    ok: results.filter((x) => x.status === "ok").length,
    skip: results.filter((x) => x.status === "skip").length,
    regressed: results.filter((x) => x.status === "regressed").length,
    inconclusive: results.filter((x) => x.status === "inconclusive").length,
    error: results.filter((x) => x.status === "error").length,
  }

  appendAudit(
    "sa_clear_le_bookkeeping", "",
    `total=${results.length} ok=${tally.ok} skip=${tally.skip} ` +
    `regressed=${tally.regressed} inconclusive=${tally.inconclusive} error=${tally.error}`,
    ip,
  )

  return NextResponse.json({
    ok: true,
    summary: tally,
    results,
    note:
      tally.regressed > 0
        ? `${tally.regressed} domain(s) regressed — auto-heal will re-install on next tick, or click Run from step 8 for those.`
        : "All eligible apps processed.",
  })
}
