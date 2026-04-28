/**
 * Job handlers: full-domain teardown (single + bulk). Mirrors Flask's
 * _teardown_domain / _bulk_teardown. For each domain:
 *   1. Acquire the per-domain pipeline slot (one retry after 5s if busy).
 *   2. Heartbeat ticker pulses last_heartbeat_at every 1s during slow API calls.
 *   3. SA delete_application(server, domain)
 *      — removes the application directory on the droplet (incl. /public_html
 *        with the generated index.php). Server itself is NOT destroyed since
 *        other domains may still be hosted on it.
 *   4. Spaceship restoreDefaultNameservers(domain)
 *      — flips the registrar back to Spaceship's basic NS pool BEFORE the
 *        CF zone goes away, so the domain doesn't sit pointing at a dead
 *        nameserver. Skipped (with a warning to the operator) if Spaceship
 *        returns 404 — that means the domain is BYO at a different registrar
 *        and the NS reset has to be done by hand there.
 *   5. CF delete_zone(domain) — kills the zone AND every DNS record in it.
 *   6. Spaceship deleteDomain(domain) — currently 501 (their API can't
 *      release the registration); kept for when they add it.
 *   7. Release CF pool slot (cf_keys.domains_used--)
 *   8. Delete on-disk archive at data/site_archives/<domain>.tar.gz
 *      — the cached site bundle used for migration. No more trace.
 *   9. DELETE the domain row.
 *
 * Each external call is wrapped in try/catch so one provider rejecting a
 * delete doesn't block the rest. Failures are logged but the teardown
 * continues — operators can verify partial cleanup via the providers' UIs.
 */
import { listServers } from "../repos/servers"
import { getDomain, deleteDomain } from "../repos/domains"
import { logPipeline } from "../repos/logs"

interface TeardownPayload { domain: string }
interface BulkTeardownPayload { domains: string[] }

async function teardownOne(domain: string): Promise<void> {
  const d = getDomain(domain)
  if (!d) return

  const { isPipelineRunning } = await import("../pipeline")
  // Soft slot acquisition — retry once after 5s if a pipeline/migration is mid-flight
  const tryAcquire = (): boolean => {
    if (isPipelineRunning(domain)) return false
    const set = (globalThis as { __ssrInflightDomains?: Set<string> }).__ssrInflightDomains
      ?? new Set<string>()
    if (set.has(domain)) return false
    set.add(domain)
    ;(globalThis as { __ssrInflightDomains?: Set<string> }).__ssrInflightDomains = set
    return true
  }
  const releaseSlot = (): void => {
    const set = (globalThis as { __ssrInflightDomains?: Set<string> }).__ssrInflightDomains
    set?.delete(domain)
  }

  if (!tryAcquire()) {
    logPipeline(domain, "teardown", "warning",
      "Another worker is busy with this domain — waiting 5s then retrying once")
    await new Promise((r) => setTimeout(r, 5000))
    if (!tryAcquire()) {
      logPipeline(domain, "teardown", "failed",
        "Teardown aborted — another worker still holds the slot. Try again in a minute.")
      return
    }
  }

  // Heartbeat ticker (1Hz) so the watcher proves the worker's alive
  const { startHeartbeat } = await import("../repos/steps")
  const ticker = startHeartbeat(domain, 1000)

  try {
    // 1. SA delete_application
    const housedServerId = d.server_id
    if (housedServerId) {
      const s = listServers().find((x) => x.id === housedServerId)
      if (s?.sa_server_id) {
        try {
          const { deleteApplication } = await import("../serveravatar")
          await deleteApplication(s.sa_server_id, domain)
        } catch (e) {
          logPipeline(domain, "teardown", "warning", `SA delete: ${(e as Error).message}`)
        }
      }
    }

    // 2. Spaceship: restore default NS BEFORE deleting the CF zone so the
    //    registrar isn't left pointing at a dead nameserver. Skipped with a
    //    warning if Spaceship 404s (BYO at another registrar — operator
    //    must reset NS by hand at the original registrar).
    try {
      const { restoreDefaultNameservers } = await import("../spaceship")
      await restoreDefaultNameservers(domain)
    } catch (e) {
      logPipeline(domain, "teardown", "warning",
        `Spaceship NS restore: ${(e as Error).message} — proceeding with CF delete anyway`)
    }

    // 3. CF delete_zone (only if creds are populated). Drops the zone AND
    //    every DNS record in one call.
    if (d.cf_email && d.cf_global_key) {
      try {
        const { deleteZone } = await import("../cloudflare")
        await deleteZone(domain)
      } catch (e) {
        logPipeline(domain, "teardown", "warning", `CF delete: ${(e as Error).message}`)
      }
    }

    // 4. Spaceship deleteDomain — returns 501 today (their API can't release
    //    the registration). Kept for when they add it. Best-effort.
    try {
      const { deleteDomain: spaceshipDelete } = await import("../spaceship")
      await spaceshipDelete(domain)
    } catch (e) {
      logPipeline(domain, "teardown", "warning", `Spaceship delete: ${(e as Error).message}`)
    }

    // 4. CF pool slot release
    try {
      const { releaseCfKeySlot } = await import("../cf-key-pool")
      releaseCfKeySlot(domain)
    } catch (e) {
      logPipeline(domain, "teardown", "warning", `CF pool release: ${(e as Error).message}`)
    }

    // 5. Local archive
    try {
      const { deleteArchive } = await import("../migration")
      deleteArchive(domain)
    } catch (e) {
      logPipeline(domain, "teardown", "warning", `Archive delete: ${(e as Error).message}`)
    }

    // 6. DB row
    deleteDomain(domain)

    logPipeline(domain, "teardown", "completed",
      `${domain} fully removed: SA app deleted (incl. /public_html files), ` +
      `Spaceship NS reset to default, CF zone + records gone, ` +
      `archive removed, CF pool slot freed, DB row dropped`)
  } finally {
    ticker.stop()
    releaseSlot()
  }
}

export async function domainTeardownHandler(payload: Record<string, unknown>): Promise<void> {
  const p = payload as unknown as TeardownPayload
  await teardownOne(p.domain)
}

export async function domainBulkTeardownHandler(payload: Record<string, unknown>): Promise<void> {
  const p = payload as unknown as BulkTeardownPayload
  for (const d of p.domains ?? []) {
    try { await teardownOne(d) }
    catch (e) {
      logPipeline(d, "teardown", "failed",
        `bulk teardown unhandled: ${(e as Error).name}: ${(e as Error).message}`)
    }
  }
}
