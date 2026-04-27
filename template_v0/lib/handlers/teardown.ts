/**
 * Job handlers: full-domain teardown (single + bulk). Mirrors Flask's
 * _teardown_domain / _bulk_teardown. For each domain:
 *   1. Acquire the per-domain pipeline slot (one retry after 5s if busy).
 *   2. Heartbeat ticker pulses last_heartbeat_at every 1s during slow API calls.
 *   3. SA delete_application(server, domain)
 *   4. CF delete_zone(domain)
 *   5. Spaceship deleteDomain(domain) — usually 501 (not implemented), warns.
 *   6. Release CF pool slot (cf_keys.domains_used--)
 *   7. Delete on-disk archive
 *   8. DELETE the domain row
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

    // 2. CF delete_zone (only if creds are populated)
    if (d.cf_email && d.cf_global_key) {
      try {
        const { deleteZone } = await import("../cloudflare")
        await deleteZone(domain)
      } catch (e) {
        logPipeline(domain, "teardown", "warning", `CF delete: ${(e as Error).message}`)
      }
    }

    // 3. Spaceship delete (returns 501 today — best-effort, just records the attempt)
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
      `${domain} fully removed (SA+CF+Spaceship+DB+pool slot freed)`)
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
