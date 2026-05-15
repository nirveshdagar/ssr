/**
 * Job handler: re-issue Origin CA certs for domains that have a CF zone but
 * no cached cert. Mirrors Flask's api_backfill_origin_certs background thread.
 * Runs sequentially — CF allows multiple certs per zone, and the existing
 * cert on each server keeps serving traffic during the backfill.
 */
import { listDomains, type DomainRow } from "../repos/domains"
import { fetchOriginCaCert } from "../cloudflare"
import { saveOriginCert } from "../migration"
import { logPipeline } from "../repos/logs"
import { startHeartbeat } from "../repos/steps"

interface Payload {
  domains?: string[]    // optional explicit list; empty = scan
}

export async function certBackfillHandler(payload: Record<string, unknown>): Promise<void> {
  const p = payload as unknown as Payload
  let targets: string[]
  if (p.domains && p.domains.length) {
    targets = p.domains
  } else {
    targets = listDomains()
      .filter((d: DomainRow) => d.cf_zone_id && !d.origin_cert_pem)
      .map((d) => d.domain)
  }
  let ok = 0
  let fail = 0
  // Per-domain heartbeat ticker — pulses last_heartbeat_at every 1s during
  // each CF round-trip (~1–2s each, sometimes 5s+ if CF is slow). Without
  // this, a 60-domain backfill would have every row appear stale to the
  // watcher even though the worker is making progress.
  for (const domain of targets) {
    const ticker = startHeartbeat(domain, 1000)
    try {
      const bundle = await fetchOriginCaCert(domain)
      saveOriginCert(domain, bundle.certificate, bundle.private_key)
      ok++
    } catch (e) {
      logPipeline(domain, "cert_backfill", "warning", `re-issue failed: ${(e as Error).message}`)
      fail++
    } finally {
      ticker.stop()
    }
  }
  logPipeline(
    "(backfill)", "cert_backfill",
    fail === 0 ? "completed" : "warning",
    `Origin cert backfill: ok=${ok} fail=${fail} total=${targets.length}`,
  )
}
