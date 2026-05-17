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
import { isPipelineRunning } from "./pipeline"

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

/**
 * Per-domain probe result. `ok` is the boolean the streak counter cares
 * about; `reason`+`status` are surfaced on the dashboard so the operator
 * can see WHY a domain is down without tailing the live-checker log.
 *
 * `contentOk` is a separate signal: when the HTTPS probe is 2xx but the
 * body looks like the SA welcome page / Apache default ("files didn't
 * deploy" — step 10 silently failed), we surface that even though the
 * domain technically responds. NULL when probe failed (no body to check)
 * or content check was inconclusive.
 */
export interface LiveProbeResult {
  ok: boolean
  reason: "ok" | "timeout" | "dns_fail" | "connect_refused" | "ssl_error" | "http_4xx" | "http_5xx" | "fetch_error"
  status: number | null
  contentOk: boolean | null
}

const DEFAULT_PAGE_RE =
  /(welcome to serveravatar|<title>\s*serveravatar\s*<\/title>|<title>\s*Welcome to nginx!|<title>\s*Apache2\s+(Ubuntu|Debian)\s+Default Page|<h1>\s*It works!\s*<\/h1>)/i

function classifyBody(body: string): boolean | null {
  // Empty body / very short response → can't tell, leave NULL.
  if (body.length < 64) return null
  if (DEFAULT_PAGE_RE.test(body)) return false
  return true
}

export async function probeLive(domain: string): Promise<LiveProbeResult> {
  try {
    const res = await fetch(`https://${domain}/`, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "SSR-live-checker/1.0" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (res.status >= 200 && res.status < 400) {
      // Read first 16 KB of the body for default-page detection. Cap to
      // bound memory: a 60-domain fleet × 60s tick × full HTML download
      // would be wasteful. Default markers are always in the first KB.
      let body = ""
      try {
        if (res.body) {
          const reader = res.body.getReader()
          const decoder = new TextDecoder("utf-8", { fatal: false })
          let bytes = 0
          const CAP = 16_384
          while (bytes < CAP) {
            const { value, done } = await reader.read()
            if (done) break
            body += decoder.decode(value, { stream: true })
            bytes += value.byteLength
          }
          try { await reader.cancel() } catch { /* ignore */ }
        } else {
          body = await res.text().catch(() => "")
        }
      } catch { /* body read failed — leave content unknown */ }
      const contentOk = classifyBody(body)
      return { ok: true, reason: "ok", status: res.status, contentOk }
    }
    return {
      ok: false,
      reason: res.status >= 500 ? "http_5xx" : "http_4xx",
      status: res.status,
      contentOk: null,
    }
  } catch (e) {
    const err = e as { name?: string; message?: string; code?: string; cause?: { code?: string } }
    const code = err.code ?? err.cause?.code ?? ""
    const msg = (err.message ?? "").toLowerCase()
    // AbortSignal.timeout fires a TimeoutError / AbortError — both mean we
    // never got a response in PROBE_TIMEOUT_MS.
    if (err.name === "TimeoutError" || err.name === "AbortError" || msg.includes("timeout")) {
      return { ok: false, reason: "timeout", status: null, contentOk: null }
    }
    if (code === "ENOTFOUND" || msg.includes("getaddrinfo")) {
      return { ok: false, reason: "dns_fail", status: null, contentOk: null }
    }
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || msg.includes("refused")) {
      return { ok: false, reason: "connect_refused", status: null, contentOk: null }
    }
    if (
      msg.includes("certificate") || msg.includes("self-signed") || msg.includes("ssl") ||
      msg.includes("tls") || code === "CERT_HAS_EXPIRED" || code === "DEPTH_ZERO_SELF_SIGNED_CERT"
    ) {
      return { ok: false, reason: "ssl_error", status: null, contentOk: null }
    }
    return { ok: false, reason: "fetch_error", status: null, contentOk: null }
  }
}

async function checkOne(domain: string): Promise<boolean> {
  return (await probeLive(domain)).ok
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
  const allRows = all<DomainProbeRow>(
    `SELECT domain, status, server_id FROM domains WHERE status IN ('hosted', 'live')`,
  )
  if (allRows.length === 0) {
    // No active hosted/live domains — clear all streak entries so deleted
    // domains don't linger in module memory until process restart.
    streakUp.clear()
    streakDown.clear()
    return
  }
  // Pipeline-aware skip — when a pipeline is currently running on a domain
  // (e.g. a UI cert install is mid-cycle and Apache is briefly down for
  // the cert swap), we MUST NOT count probe failures toward the streak.
  // Otherwise we false-positive flip live → hosted on every cert reinstall
  // and the dashboard fills with "OFFLINE" warnings for sites that are
  // actually fine; the pipeline owns the domain's status during its own
  // runs. Reset both streak counters for skipped domains so a stale
  // failure from an earlier tick doesn't carry over once the pipeline
  // finishes.
  const skipped: string[] = []
  const rows = allRows.filter((r) => {
    if (isPipelineRunning(r.domain)) {
      skipped.push(r.domain)
      streakUp.delete(r.domain)
      streakDown.delete(r.domain)
      return false
    }
    return true
  })
  if (skipped.length > 0) {
    logPipeline("(live-checker)", "live_check", "running",
      `Skipped ${skipped.length} domain(s) under active pipeline: ${skipped.slice(0, 5).join(", ")}` +
      (skipped.length > 5 ? `, +${skipped.length - 5} more` : ""))
  }
  if (rows.length === 0) return
  // GC stale streak entries — domains deleted between ticks shouldn't linger.
  // Build active set from this tick's rows and prune anything not in it.
  const active = new Set<string>(rows.map((r) => r.domain))
  for (const k of streakUp.keys()) if (!active.has(k)) streakUp.delete(k)
  for (const k of streakDown.keys()) if (!active.has(k)) streakDown.delete(k)

  const probeResults = await mapPool(rows, PROBE_MAX_WORKERS, (r) => probeLive(r.domain))
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")

  // Group by server for whole-server dead detection
  const byServer = new Map<number, { domain: string; downStreak: number }[]>()

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const probe = probeResults[i]
    const up = probe.ok
    // Persist per-domain liveness so the /domains page renders the Live
    // dot without re-probing on every render. Failure tracking still goes
    // through the in-memory streak counters below — the DB columns are a
    // snapshot of the LATEST probe, not a streak.
    try {
      const contentVal = probe.contentOk === true ? 1 : probe.contentOk === false ? 0 : null
      // Only update content_checked_at when we actually got a body to
      // classify (probe was 2xx). Otherwise the column timestamp would
      // suggest a check happened when it didn't.
      const contentCheckedAt = probe.contentOk !== null ? nowIso : null
      run(
        `UPDATE domains
            SET live_ok = ?, live_reason = ?, live_http_status = ?, live_checked_at = ?,
                content_ok = COALESCE(?, content_ok),
                content_checked_at = COALESCE(?, content_checked_at)
          WHERE domain = ?`,
        up ? 1 : 0, probe.reason, probe.status, nowIso,
        contentVal, contentCheckedAt,
        r.domain,
      )
    } catch { /* ignore — schema may not be migrated yet on first boot */ }
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
/**
 * SA-side liveness probe. If SA says the agent is "disconnected" / "offline"
 * (or returns 404 — the SA-side row is gone entirely), treat as confirmation
 * that the server is dead. Conservative: only fires on explicitly-bad SA
 * statuses, not on transient network failures (returns null in that case so
 * the slow-path threshold still gates the dead-mark).
 */
export async function probeSaAgentDead(saServerId: string): Promise<string | null> {
  // SA's cloud<->agent link flaps constantly — a SINGLE 'disconnected' /
  // 'offline' reading (or a transient 404) is NOT proof the box is dead.
  // Trusting one reading was the #1 cause of healthy servers being killed
  // and auto-migrated. Re-confirm with a second poll a few seconds later;
  // only declare dead if BOTH polls independently say so.
  const poll = async (): Promise<string | null> => {
    try {
      const { getServerInfo } = await import("./serveravatar")
      const info = await getServerInfo(saServerId)
      const status = String(info.agent_status ?? info.status ?? "").toLowerCase()
      if (status === "disconnected" || status === "offline" || status === "0") {
        return `SA agent_status='${status}'`
      }
      return null
    } catch (e) {
      if ((e as Error).message.includes("HTTP 404")) {
        return "SA 404 (server entry deleted from ServerAvatar)"
      }
      return null // transient (timeout/5xx/network) — NOT proof of death
    }
  }
  const first = await poll()
  if (!first) return null
  const reconfirmMs = Number(process.env.SSR_SA_RECONFIRM_MS) || 4000
  await new Promise((r) => setTimeout(r, reconfirmMs))
  const second = await poll()
  if (!second) return null // flapped back within seconds → it was transient
  return `${first}; re-confirmed after 4s (${second}) — SA reports unreachable twice`
}

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

export async function checkDeadServers(
  byServer: Map<number, { domain: string; downStreak: number }[]>,
): Promise<void> {
  const thresholdRaw = parseInt(getSetting("dead_server_threshold_ticks") || "10", 10)
  const threshold = Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? thresholdRaw : 10
  const autoMigrate = (getSetting("auto_migrate_enabled") || "0") === "1"

  const servers = all<{ id: number; name: string; ip: string; status: string; do_droplet_id: string | null; sa_server_id: string | null }>(
    `SELECT id, name, ip, status, do_droplet_id, sa_server_id FROM servers WHERE status = 'ready'`,
  )

  // The SA fast-path leans on SA's flaky agent_status, so it needs a much
  // higher HTTPS-failure gate than the DO fast-path (DO 404/archive is
  // hard evidence; SA 'disconnected' is not). Tie it to the operator's
  // configured tolerance, never below 4.
  const saFastGate = Math.max(4, Math.ceil(threshold / 2))

  // Global sanity guard: if EVERY ready server's domains are failing in
  // the SAME tick, that's overwhelmingly a dashboard-side / CF-wide
  // network problem — not every server dying simultaneously. Mass
  // dead-marking here is catastrophic (spurious droplets + prod domain
  // churn). Skip this tick; a genuinely-dead single server is still
  // caught on later ticks (once others recover this guard stops tripping)
  // by the unchanged slow threshold.
  if (servers.length >= 2) {
    const downServers = servers.filter((s) => {
      const e = byServer.get(s.id)
      return e !== undefined && e.length > 0 && e.every((x) => x.downStreak >= 2)
    })
    if (downServers.length === servers.length) {
      logPipeline("(live-checker)", "dead_detect", "warning",
        `ALL ${servers.length} ready servers' domains failing this tick — ` +
        `treating as a dashboard-side / CF network problem, NOT mass server ` +
        `death. Skipping dead-marks this tick (slow threshold still applies ` +
        `to any single server that stays down once others recover).`)
      return
    }
  }

  for (const s of servers) {
    const entries = byServer.get(s.id)
    if (!entries || entries.length === 0) continue
    const allDown = entries.every((e) => e.downStreak >= threshold)
    const worst = entries.reduce((m, e) => Math.max(m, e.downStreak), 0)

    // "Down enough to even investigate this server." Slow path = the full
    // threshold; DO fast-gate = 2 ticks (a 404/archive is hard evidence so
    // we may act sooner); SA fast-gate = saFastGate (SA's agent_status
    // flaps, so it needs many more ticks). Below all of these → ignore.
    const downEnough =
      allDown ||
      (s.do_droplet_id != null && entries.every((e) => e.downStreak >= 2)) ||
      (s.sa_server_id != null && entries.every((e) => e.downStreak >= saFastGate))
    if (!downEnough) continue

    // HARD RULE — the false-dead fix. "All sites down" is necessary but
    // NEVER sufficient to declare a SERVER dead and migrate it. Migration
    // is expensive and near-irreversible (fresh $$ droplet + prod domain
    // churn + old box torn down), and all-sites-down is FAR more often a
    // site/SSL/CF/nginx fault on a perfectly ALIVE droplet than an actual
    // dead box. So before ever migrating, REQUIRE positive proof the box
    // itself is gone: DO reports the droplet 404/archived, OR SA
    // re-confirms (two polls) the agent is offline/disconnected. The old
    // slow path skipped these probes entirely once allDown was true and
    // migrated on HTTPS-failure alone — that is what kept killing healthy
    // servers and double-provisioning. If neither probe confirms death,
    // the server is alive: refuse to migrate, log loudly, and leave the
    // real (site-level) cause to auto-heal / the operator.
    let deadReason: string | null = null
    if (s.do_droplet_id) deadReason = await probeDropletFastDead(s.do_droplet_id)
    if (!deadReason && s.sa_server_id) deadReason = await probeSaAgentDead(s.sa_server_id)

    if (!deadReason) {
      const why = (!s.do_droplet_id && !s.sa_server_id)
        ? "no DO/SA handle on this server row, so liveness is unverifiable — " +
          "NOT migrating on HTTPS-failure alone"
        : "DO/SA confirm the droplet + agent are ALIVE"
      logPipeline(`server-${s.id}`, "dead_detect", "warning",
        `Server #${s.id} (${s.name} / ${s.ip}): all ${entries.length} site(s) ` +
        `failing HTTPS for ${worst}+ tick(s), but ${why}. This is a ` +
        `site/SSL/CF/nginx problem, NOT server death — REFUSING to migrate ` +
        `(migrating would burn a fresh droplet for nothing). Fix the site ` +
        `cause; auto-heal + the next live-check tick will re-evaluate.`)
      continue
    }

    // Short-circuit: already migrating
    if (migrating.has(s.id)) continue
    migrating.add(s.id)

    run(`UPDATE servers SET status='dead' WHERE id = ?`, s.id)
    logPipeline(`server-${s.id}`, "dead_detect", "warning",
      `Server #${s.id} (${s.name} / ${s.ip}) marked DEAD — server-liveness ` +
      `CONFIRMED gone: ${deadReason} · ${entries.length} site(s) failing for ` +
      `${worst}+ tick(s) (threshold=${threshold})`)

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
  // Emit a `running` log entry IMMEDIATELY so the auto-heal deadRetry
  // sweep's in-flight check (auto-heal.ts:1700, which scans pipeline_log
  // for `domain='server-X' step='auto_migrate' status='running'`) can
  // see this migration is in progress and skip its retry.
  //
  // Without this, the previous code only logged `auto_migrate completed/
  // warning/failed` AFTER migrateServer returned 5-15 minutes later.
  // During that window the deadRetry sweep saw no in-flight signal,
  // assumed the migration had failed, and spawned a SECOND migration —
  // producing the duplicate-droplet bug observed 2026-05-14 (phoenix
  // and portland both provisioned for the same dead dallas server, ~$).
  logPipeline(`server-${serverId}`, "auto_migrate", "running",
    `Migration started for dead server #${serverId} — provisioning + ` +
    `transferring domains (typical 5-15 min).`)
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
