/**
 * Background live-checker — Node port of modules/live_checker.py.
 *
 * Watches every `status IN ('hosted','live')` domain and flips between them
 * based on HTTPS probe results. Detects whole-server outages and (optionally)
 * auto-migrates their domains.
 *
 * Parallel-Flask gating: Flask runs its own live_checker by default. Running
 * BOTH against the same `data/ssr.db` would cause status thrash (both apps
 * keep independent streak counters, and whichever transitions first wins).
 * To avoid that, the Node checker is OFF by default — set the env var
 * `SSR_LIVE_CHECKER=1` to enable it (and stop the Flask one first).
 *
 * State is per-process: streak counters live in module memory and reset on
 * restart. The DB only stores the resulting status flips.
 *
 * Auto-migrate path calls into modules/migration.py which is NOT ported yet.
 * The dead-server detection + status='dead' flip still works — auto-migrate
 * is a try/catch best-effort hook that becomes real when migration lands.
 */

import { all, getDb, one, run } from "./db"
import { getSetting } from "./repos/settings"
import { logPipeline } from "./repos/logs"

// Concurrent HTTPS probe cap — keeps a 60-domain fleet under ~10s/tick even
// when many timeout. Without bounding, 60 simultaneous fetches would flood
// any one CF edge.
const PROBE_MAX_WORKERS = 20
const PROBE_TIMEOUT_MS = 8000

// Module-scope state
const streakUp = new Map<string, number>()
const streakDown = new Map<string, number>()
const migrating = new Set<number>()

let stopRequested = false
let runningPromise: Promise<void> | null = null

// ---------------------------------------------------------------------------
// One probe
// ---------------------------------------------------------------------------

async function checkOne(domain: string): Promise<boolean> {
  try {
    const res = await fetch(`https://${domain}/`, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "SSR-live-checker/1.0" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return res.status >= 200 && res.status < 400
  } catch {
    return false
  }
}

/**
 * Bounded-concurrency map. Same shape as the Python ThreadPoolExecutor —
 * up to N parallel probes; resolves with results in input order.
 */
async function mapPool<T, R>(
  items: T[], limit: number, fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// One tick
// ---------------------------------------------------------------------------

interface DomainProbeRow {
  domain: string
  status: string
  server_id: number | null
}

async function tick(): Promise<void> {
  const rows = all<DomainProbeRow>(
    `SELECT domain, status, server_id FROM domains WHERE status IN ('hosted', 'live')`,
  )
  if (rows.length === 0) return

  const upResults = await mapPool(rows, PROBE_MAX_WORKERS, (r) => checkOne(r.domain))

  // Group by server for whole-server dead detection
  const byServer = new Map<number, { domain: string; downStreak: number }[]>()

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const up = upResults[i]
    if (up) {
      streakUp.set(r.domain, (streakUp.get(r.domain) ?? 0) + 1)
      streakDown.set(r.domain, 0)
    } else {
      streakDown.set(r.domain, (streakDown.get(r.domain) ?? 0) + 1)
      streakUp.set(r.domain, 0)
    }
    if (r.server_id != null) {
      const arr = byServer.get(r.server_id) ?? []
      arr.push({ domain: r.domain, downStreak: streakDown.get(r.domain) ?? 0 })
      byServer.set(r.server_id, arr)
    }

    // hosted → live: 2 consecutive 2xx/3xx wins
    if (r.status === "hosted" && (streakUp.get(r.domain) ?? 0) >= 2) {
      run(
        `UPDATE domains SET status='live', updated_at=datetime('now') WHERE domain = ?`,
        r.domain,
      )
      logPipeline(r.domain, "live_check", "completed",
        "Domain went LIVE (2 consecutive successful HTTPS checks)")
    }
    // live → hosted: 3 consecutive failures
    else if (r.status === "live" && (streakDown.get(r.domain) ?? 0) >= 3) {
      run(
        `UPDATE domains SET status='hosted', updated_at=datetime('now') WHERE domain = ?`,
        r.domain,
      )
      logPipeline(r.domain, "live_check", "warning",
        "Domain OFFLINE — 3 consecutive HTTPS failures, reverted status to 'hosted'")
    }
  }

  await checkDeadServers(byServer)
}

// ---------------------------------------------------------------------------
// Whole-server dead detection
// ---------------------------------------------------------------------------

/**
 * Quick DO probe for "definitively dead" droplet states. Used by the
 * live-checker fast-path to short-circuit the down-streak threshold when
 * we have hard evidence the droplet is gone.
 *
 * Returns a reason string if the droplet is unambiguously dead, else null
 * (in which case the caller falls back to the normal threshold).
 *
 * Conservative: only treats 404 (deleted) and status='archive' (permanently
 * powered off) as fast-dead. status='off' is treated as transient since
 * operators frequently power-cycle droplets, and we don't want to migrate
 * a domain mid-reboot.
 */
async function probeDropletFastDead(dropletId: string): Promise<string | null> {
  try {
    const { getDroplet } = await import("./digitalocean")
    const d = await getDroplet(dropletId)
    if (d.status === "archive") return `DO droplet status='archive' (powered off permanently)`
    return null
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes("HTTP 404")) return "DO droplet returns 404 (deleted from account)"
    return null  // auth / network / 5xx — let normal threshold handle
  }
}

async function checkDeadServers(
  byServer: Map<number, { domain: string; downStreak: number }[]>,
): Promise<void> {
  const thresholdRaw = parseInt(getSetting("dead_server_threshold_ticks") || "10", 10)
  const threshold = Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? thresholdRaw : 10
  const autoMigrate = (getSetting("auto_migrate_enabled") || "0") === "1"

  const servers = all<{ id: number; name: string; ip: string; status: string; do_droplet_id: string | null }>(
    `SELECT id, name, ip, status, do_droplet_id FROM servers WHERE status = 'ready'`,
  )

  for (const s of servers) {
    const entries = byServer.get(s.id)
    if (!entries || entries.length === 0) continue
    const allDown = entries.every((e) => e.downStreak >= threshold)

    // Fast-path: if all domains on this server have failed at least 2 ticks
    // AND DO confirms the droplet is gone (404) or archived, declare dead
    // NOW instead of waiting for the full threshold. Saves up to ~9 minutes
    // on the default 10-tick × 60-s setup when an operator deletes the
    // droplet from the DO console.
    let fastReason: string | null = null
    if (!allDown && s.do_droplet_id && entries.every((e) => e.downStreak >= 2)) {
      fastReason = await probeDropletFastDead(s.do_droplet_id)
    }
    if (!allDown && !fastReason) continue

    // Short-circuit: already migrating
    if (migrating.has(s.id)) continue
    migrating.add(s.id)

    run(`UPDATE servers SET status='dead' WHERE id = ?`, s.id)
    const worst = entries.reduce((m, e) => Math.max(m, e.downStreak), 0)
    const msg = fastReason
      ? `Server #${s.id} (${s.name} / ${s.ip}) marked DEAD via fast-path — ` +
        `${fastReason} · ${entries.length} domain(s) failing for ${worst}+ tick(s)`
      : `Server #${s.id} (${s.name} / ${s.ip}) marked DEAD — ` +
        `all ${entries.length} domains down for ${worst}+ ticks (threshold=${threshold})`
    logPipeline(`server-${s.id}`, "dead_detect", "warning", msg)

    // Multi-channel alert (best-effort — notify module is wired separately)
    try {
      const { notifyServerDead } = await import("./notify")
      await notifyServerDead(s.id, s.name, s.ip, entries.length)
    } catch (e) {
      logPipeline(`server-${s.id}`, "notify", "warning",
        `dead-server notify failed: ${(e as Error).message}`)
    }

    if (autoMigrate) {
      void spawnMigration(s.id)
    } else {
      logPipeline(`server-${s.id}`, "dead_detect", "warning",
        "Auto-migrate DISABLED — click 'Migrate Now' on the Servers page to " +
        "move domains, or enable auto_migrate_enabled in Settings.")
      migrating.delete(s.id)
    }
  }
}

/**
 * Best-effort cleanup of a dead server after auto-migrate has moved its
 * domains. Removes:
 *   1. The SA server entry (zombie that SA itself doesn't auto-remove
 *      when the agent disconnects)
 *   2. The DB row in `servers` — but ONLY if migration was 100% successful
 *      AND no domains still reference this server. Anything less, the row
 *      stays so the operator can investigate the failed migrations.
 *
 * Goes through saRequest so primary→backup token failover applies. SA 404
 * is treated as success — already gone.
 */
async function cleanupDeadServerSaEntry(
  serverId: number, fullSuccess: boolean,
): Promise<void> {
  let saCleanedOrAlreadyGone = false
  try {
    const row = one<{ sa_server_id: string | null; name: string | null }>(
      "SELECT sa_server_id, name FROM servers WHERE id = ?", serverId,
    )
    if (!row?.sa_server_id) {
      saCleanedOrAlreadyGone = true
    } else {
      const { saRequest } = await import("./serveravatar")
      const { res, label } = await saRequest(
        `/organizations/{ORG_ID}/servers/${row.sa_server_id}`,
        { method: "DELETE", timeoutMs: 30_000 },
      )
      if (res.ok || res.status === 204) {
        logPipeline(`server-${serverId}`, "auto_migrate", "completed",
          `Cleaned up zombie SA server entry ${row.sa_server_id} (via ${label} token)`)
        saCleanedOrAlreadyGone = true
      } else if (res.status === 404) {
        logPipeline(`server-${serverId}`, "auto_migrate", "completed",
          `SA entry ${row.sa_server_id} already gone (404) — no cleanup needed`)
        saCleanedOrAlreadyGone = true
      } else {
        logPipeline(`server-${serverId}`, "auto_migrate", "warning",
          `SA cleanup HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
    }
  } catch (e) {
    logPipeline(`server-${serverId}`, "auto_migrate", "warning",
      `SA cleanup failed (best-effort): ${(e as Error).message}`)
  }

  // Auto-drop the DB row when it's provably useless: migration was fully
  // successful, no domains still reference this server, and the SA entry
  // is gone. Anything else, leave the row for operator review.
  if (!fullSuccess || !saCleanedOrAlreadyGone) return
  try {
    const refRow = one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM domains WHERE server_id = ?", serverId,
    )
    const refCount = refRow?.n ?? 0
    if (refCount > 0) {
      logPipeline(`server-${serverId}`, "auto_migrate", "warning",
        `Server #${serverId} still has ${refCount} domain row(s) — skipping DB-row drop. ` +
        `Investigate the failed migrations.`)
      return
    }
    run("DELETE FROM servers WHERE id = ?", serverId)
    logPipeline(`server-${serverId}`, "auto_migrate", "completed",
      `Dropped DB row for server #${serverId} — auto-migrate fully succeeded, ` +
      `SA entry cleaned up, droplet was deleted, no domains reference it.`)
  } catch (e) {
    logPipeline(`server-${serverId}`, "auto_migrate", "warning",
      `DB row drop failed (best-effort): ${(e as Error).message}`)
  }
}

/**
 * Run the migration in the background. Releases the `migrating` slot when
 * done (success OR failure) so a subsequent dead-detect can re-fire if the
 * server stays down.
 *
 * After successful migration, also fires `cleanupDeadServerSaEntry` so the
 * SA dashboard isn't left with a disconnected zombie row.
 */
async function spawnMigration(serverId: number): Promise<void> {
  try {
    const { migrateServer } = await import("./migration")
    const result = await migrateServer(serverId)
    logPipeline(`server-${serverId}`, "auto_migrate",
      result.failed.length === 0 ? "completed" : "warning",
      `${result.msg}  ok=${result.ok.length} failed=${result.failed.length}`)
    // Clean up the zombie SA entry only if at least one domain successfully
    // migrated. Total migration failure means the source might still be in
    // use; leave SA alone so the operator can investigate.
    // The DB row drop is gated separately on `fullSuccess` (no failures)
    // inside cleanupDeadServerSaEntry — partial success cleans SA but
    // keeps the row for review.
    if (result.ok.length > 0) {
      const fullSuccess = result.failed.length === 0
      await cleanupDeadServerSaEntry(serverId, fullSuccess)
    }
    try {
      const { notifyMigrationDone } = await import("./notify")
      await notifyMigrationDone(serverId, result.msg, result.ok.length, result.failed.length)
    } catch { /* best-effort */ }
  } catch (e) {
    logPipeline(`server-${serverId}`, "auto_migrate", "failed",
      `migrateServer raised: ${(e as Error).message}`)
    try {
      const { notify } = await import("./notify")
      await notify(
        `Auto-migrate CRASHED: server #${serverId}`,
        `migrateServer raised ${(e as Error).name}: ${(e as Error).message}\n\n` +
        `Domains on this server are likely still offline. Intervene manually from the dashboard.`,
        { severity: "error" },
      )
    } catch { /* ignore */ }
  } finally {
    migrating.delete(serverId)
  }
}

// ---------------------------------------------------------------------------
// Loop + supervisor
// ---------------------------------------------------------------------------

async function sleepCancellable(seconds: number): Promise<void> {
  for (let i = 0; i < Math.max(1, seconds); i++) {
    if (stopRequested) return
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function innerLoop(): Promise<void> {
  while (!stopRequested) {
    try {
      await tick()
    } catch (e) {
      try {
        logPipeline("(live-checker)", "live_check", "warning",
          `tick error: ${(e as Error).message}`)
      } catch { /* DB hiccup */ }
    }
    const intervalRaw = parseInt(getSetting("live_check_interval_s") || "60", 10)
    const interval = Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : 60
    await sleepCancellable(interval)
  }
}

async function supervisedLoop(): Promise<void> {
  let restartCount = 0
  let lastRestart = 0
  while (!stopRequested) {
    try {
      await innerLoop()
      return // clean exit (stopRequested)
    } catch (e) {
      restartCount++
      const now = Date.now() / 1000
      if (now - lastRestart < 60 && restartCount > 3) {
        try {
          logPipeline("(live-checker)", "supervisor", "failed",
            `crash-looping (${restartCount} restarts in <60s) — giving up until ` +
            `stop+start: ${(e as Error).message}`)
        } catch { /* ignore */ }
        return
      }
      lastRestart = now
      try {
        logPipeline("(live-checker)", "supervisor", "warning",
          `inner loop crashed (restart #${restartCount}): ` +
          `${(e as Error).name}: ${(e as Error).message}`)
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

// ---------------------------------------------------------------------------
// Public start / stop / status
// ---------------------------------------------------------------------------

export function start(): void {
  if (runningPromise) return
  stopRequested = false
  runningPromise = supervisedLoop().finally(() => { runningPromise = null })
}

export async function stop(): Promise<void> {
  stopRequested = true
  if (runningPromise) {
    await runningPromise
  }
}

export function isRunning(): boolean {
  return runningPromise !== null
}

export interface LiveCheckerStatus {
  running: boolean
  streak_up: Record<string, number>
  streak_down: Record<string, number>
  migrating_server_ids: number[]
}

export function status(): LiveCheckerStatus {
  return {
    running: isRunning(),
    streak_up: Object.fromEntries(streakUp),
    streak_down: Object.fromEntries(streakDown),
    migrating_server_ids: [...migrating].sort((a, b) => a - b),
  }
}

/** Reset streak state — useful for tests. The DB rows are NOT touched. */
export function _resetState(): void {
  streakUp.clear()
  streakDown.clear()
  migrating.clear()
}

// Cross-module guards used by the manual /migrate-now route to avoid
// double-triggering migration while auto-detection has it in flight.
export function tryMarkServerMigrating(serverId: number): boolean {
  if (migrating.has(serverId)) return false
  migrating.add(serverId)
  return true
}

export function releaseServerMigrating(serverId: number): void {
  migrating.delete(serverId)
}

/** Clear down-streaks for every domain on a server (used by mark-ready). */
export function clearDownStreaksForServerDomains(domainsOnServer: string[]): void {
  for (const d of domainsOnServer) {
    streakDown.delete(d)
    streakUp.delete(d)
  }
}

// silence "getDb unused" — it's exported for symmetry but tick uses all/run
export const __debug = { getDb }
