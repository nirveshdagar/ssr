/**
 * Periodic self-heal sweeper — turns the manual "Reconcile from SA" button
 * into a background loop, plus auto-resumes stalled pipelines.
 *
 * Three jobs per tick (each independent — one failing doesn't block the others):
 *
 *   1. reconcileOrphanServers
 *      Walk SA, match by IP, back-fill sa_server_id + status='ready' on DB
 *      rows that lost their link (e.g. SSH timeout aborted step-6 install
 *      after the SA agent already connected).
 *
 *   2. autoResumeStuckPipelines
 *      For each server claimed by (1), find domains in retryable_error that
 *      were pinned to that server and re-enqueue pipeline.full with
 *      start_from=6 — step 6 picks up the now-ready server, no second droplet.
 *
 *   3. autoCheckPendingNs
 *      For each domain stuck at ns_set / ns_pending_external, call CF's
 *      zone-status endpoint; if active, enqueue pipeline.full with
 *      start_from=5 so the run continues without manual intervention.
 *
 * Disabled in tests (NODE_ENV=test) and skippable via SSR_AUTOHEAL=0.
 */

import { listServers as listDbServers, updateServer } from "./repos/servers"
import { listServers as listSaServers } from "./serveravatar"
import { listDomains } from "./repos/domains"
import { getSetting } from "./repos/settings"
import { logPipeline } from "./repos/logs"
import { appendAudit } from "./repos/audit"
import { isRetryableError } from "./status-taxonomy"
import { isPipelineRunning, runFullPipeline } from "./pipeline"
import { getZoneStatus } from "./cloudflare"
import { all, one } from "./db"

// ---------------------------------------------------------------------------
// 1. Reconcile orphan servers from SA
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  claimed: { id: number; name: string | null; ip: string | null; sa_server_id: string }[]
  stillOrphaned: { id: number; name: string | null; ip: string | null; reason: string }[]
  alreadyOk: number
}

export async function reconcileOrphanServers(
  opts: { dryRun?: boolean } = {},
): Promise<ReconcileResult> {
  const dryRun = !!opts.dryRun
  const saServers = await listSaServers() // throws on SA API failure

  const saByIp = new Map<string, typeof saServers[number]>()
  for (const s of saServers) {
    const sIp = String(s.server_ip ?? s.ip ?? "").trim()
    if (sIp) saByIp.set(sIp, s)
  }

  const orgId = (getSetting("serveravatar_org_id") || "").trim()
  const claimed: ReconcileResult["claimed"] = []
  const stillOrphaned: ReconcileResult["stillOrphaned"] = []
  let alreadyOk = 0

  for (const row of listDbServers()) {
    if (row.sa_server_id && row.status === "ready") {
      alreadyOk++
      continue
    }
    // Hands off 'dead' rows. Status='dead' is set by the live-checker (after
    // N consecutive HTTPS failures) or by an operator's mark-dead — either
    // way it's a deliberate signal that this server is being retired.
    // Reconciling it back to 'ready' would race with auto-migrate (which
    // may already be in flight) and reverse the live-checker's verdict
    // based on a transient SA-agent-still-pinging signal. Operator must
    // explicitly mark-ready to bring a dead server back into rotation.
    if (row.status === "dead") {
      stillOrphaned.push({
        id: row.id, name: row.name, ip: row.ip,
        reason: "status='dead' — left for live-checker / operator to manage",
      })
      continue
    }
    const dbIp = (row.ip ?? "").trim()
    if (!dbIp) {
      stillOrphaned.push({ id: row.id, name: row.name, ip: row.ip, reason: "no IP on DB row" })
      continue
    }
    const match = saByIp.get(dbIp)
    if (!match) {
      stillOrphaned.push({
        id: row.id, name: row.name, ip: row.ip,
        reason: `no SA server with ip=${dbIp}`,
      })
      continue
    }
    const saStatus = String(match.agent_status ?? match.status ?? "")
    const isConnected = saStatus === "connected" || saStatus === "active" || saStatus === "1"
    if (!isConnected) {
      stillOrphaned.push({
        id: row.id, name: row.name, ip: row.ip,
        reason: `SA agent_status='${saStatus}' (waiting for connect)`,
      })
      continue
    }

    const saId = String(match.id ?? "")
    if (!saId) {
      stillOrphaned.push({
        id: row.id, name: row.name, ip: row.ip,
        reason: "SA server has no id field",
      })
      continue
    }

    if (!dryRun) {
      updateServer(row.id, {
        sa_server_id: saId,
        sa_org_id: orgId || row.sa_org_id || null,
        status: "ready",
      } as Parameters<typeof updateServer>[1])
      logPipeline(`server-${row.id}`, "reconcile_sa", "completed",
        `Auto-claimed orphan: linked sa_server_id=${saId} (was status='${row.status}')`)
    }

    claimed.push({ id: row.id, name: row.name, ip: row.ip, sa_server_id: saId })
  }

  return { claimed, stillOrphaned, alreadyOk }
}

// ---------------------------------------------------------------------------
// 2. Resume retryable_error domains pinned to a freshly-claimed server
// ---------------------------------------------------------------------------

export interface ResumeResult {
  resumed: { domain: string; server_id: number; job_id: number | null }[]
  skipped: { domain: string; reason: string }[]
}

export function autoResumeStuckPipelines(claimedServerIds: number[]): ResumeResult {
  const resumed: ResumeResult["resumed"] = []
  const skipped: ResumeResult["skipped"] = []
  if (claimedServerIds.length === 0) return { resumed, skipped }

  const claimedSet = new Set(claimedServerIds)
  for (const d of listDomains()) {
    if (d.server_id == null || !claimedSet.has(d.server_id)) continue
    if (!isRetryableError(d.status)) {
      skipped.push({ domain: d.domain, reason: `status='${d.status}' (not retryable)` })
      continue
    }
    if (isPipelineRunning(d.domain)) {
      skipped.push({ domain: d.domain, reason: "already running" })
      continue
    }
    // start_from=6 so step 6 picks up the now-ready pinned server (no
    // re-provision); we don't pass server_id because the pipeline will
    // resolve d.server_id from the row itself.
    const jobId = runFullPipeline(d.domain, { startFrom: 6 })
    if (jobId == null) {
      skipped.push({ domain: d.domain, reason: "slot lock rejected" })
      continue
    }
    logPipeline(d.domain, "auto_heal", "running",
      `Auto-resume: server #${d.server_id} just claimed; restarting from step 6`)
    resumed.push({ domain: d.domain, server_id: d.server_id, job_id: jobId })
  }
  return { resumed, skipped }
}

// ---------------------------------------------------------------------------
// 3. Recheck NS-pending domains against CF zone status
// ---------------------------------------------------------------------------

export interface NsCheckResult {
  resumed: { domain: string; job_id: number | null }[]
  stillWaiting: { domain: string; status: string }[]
  errors: { domain: string; error: string }[]
}

export async function autoCheckPendingNs(): Promise<NsCheckResult> {
  const resumed: NsCheckResult["resumed"] = []
  const stillWaiting: NsCheckResult["stillWaiting"] = []
  const errors: NsCheckResult["errors"] = []

  for (const d of listDomains()) {
    if (d.status !== "ns_set" && d.status !== "ns_pending_external") continue
    if (isPipelineRunning(d.domain)) continue

    let zoneStatus: string
    try {
      zoneStatus = await getZoneStatus(d.domain)
    } catch (e) {
      errors.push({ domain: d.domain, error: (e as Error).message.slice(0, 200) })
      continue
    }
    if (zoneStatus !== "active") {
      stillWaiting.push({ domain: d.domain, status: zoneStatus })
      continue
    }
    // Zone went active — resume from step 5 (which sees zone_active and
    // skips, then step 6 picks up).
    const jobId = runFullPipeline(d.domain, { startFrom: 5 })
    if (jobId == null) {
      errors.push({ domain: d.domain, error: "slot lock rejected" })
      continue
    }
    logPipeline(d.domain, "auto_heal", "running",
      `Auto-resume: CF zone went ACTIVE; restarting pipeline from step 5`)
    resumed.push({ domain: d.domain, job_id: jobId })
  }
  return { resumed, stillWaiting, errors }
}

// ---------------------------------------------------------------------------
// 4. Generic retry of retryable_error / error domains after cooldown
// ---------------------------------------------------------------------------
//
// The first three paths cover specific recovery cases (claimed orphan,
// CF zone activation). This one is the catch-all: any domain in a
// retryable error state gets re-enqueued after a cooldown, so transient
// failures (DO API hiccup, CF rate-limit, SSH glitch) self-heal without
// a human click.
//
// Guardrails:
//   - cooldown (default 30 min, env SSR_AUTOHEAL_RETRY_COOLDOWN_MS)
//     compared against domains.last_heartbeat_at — recent failures wait
//   - per-domain cap (default 5/24h, env SSR_AUTOHEAL_RETRY_MAX_PER_DAY)
//     from pipeline_runs.status='failed' count — gives up on truly broken
//     domains so we don't burn external API quota on a hopeless retry loop
//   - terminal errors (content_blocked, cf_pool_full, terminal_error,
//     purchase_failed) are NOT in retryable_error so they're skipped — those
//     genuinely need a human (override the niche, add CF capacity, etc).
//
// Effect: a domain that fails for any retryable reason will retry roughly
// once every 30 min until it succeeds OR has accumulated 5 failed runs in
// 24h, then sits until the operator intervenes.

export interface RetryResult {
  retried: { domain: string; status: string; failed_runs_24h: number; job_id: number | null }[]
  skipped: { domain: string; reason: string }[]
}

const DEFAULT_RETRY_COOLDOWN_MS = 30 * 60 * 1000
const DEFAULT_RETRY_MAX_PER_DAY = 5

export function autoRetryRetryable(): RetryResult {
  const retried: RetryResult["retried"] = []
  const skipped: RetryResult["skipped"] = []

  const cooldownMs = Math.max(
    60_000,
    Number.parseInt(process.env.SSR_AUTOHEAL_RETRY_COOLDOWN_MS ?? "", 10) || DEFAULT_RETRY_COOLDOWN_MS,
  )
  const maxPerDay = Math.max(
    1,
    Number.parseInt(process.env.SSR_AUTOHEAL_RETRY_MAX_PER_DAY ?? "", 10) || DEFAULT_RETRY_MAX_PER_DAY,
  )
  // SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" (space separator) so
  // we MUST match that format for the lexicographic comparison. Using JS's
  // toISOString ("YYYY-MM-DDTHH:MM:SS") would sort space < T and treat
  // every fresh heartbeat as older than the threshold — making the cooldown
  // a no-op and letting auto-heal stomp on freshly-failed runs every tick.
  const cooldownThreshold = new Date(Date.now() - cooldownMs).toISOString().slice(0, 19).replace("T", " ")

  for (const d of listDomains()) {
    if (!isRetryableError(d.status)) continue
    if (isPipelineRunning(d.domain)) {
      skipped.push({ domain: d.domain, reason: "already running" })
      continue
    }
    // Cooldown — wait at least cooldownMs since last heartbeat (which the
    // pipeline pulses every 1s during a run AND once at end, so this gates
    // both in-flight and just-finished failures).
    const heartbeatTs = (d.last_heartbeat_at ?? "").trim()
    if (heartbeatTs && heartbeatTs > cooldownThreshold) {
      skipped.push({ domain: d.domain, reason: `cooldown (heartbeat ${heartbeatTs} < ${cooldownThreshold})` })
      continue
    }
    // Per-domain 24h cap on failed runs — stops infinite retry loops on
    // genuinely broken domains.
    //
    // pipeline_runs.ended_at is a REAL (unix epoch seconds) — use a numeric
    // comparison, NOT an ISO string. SQLite would otherwise parseFloat the
    // string "2026-..." → 2026, making the comparison always true and the
    // 24h cap a no-op.
    const sinceEpoch = (Date.now() - 24 * 3600 * 1000) / 1000
    const failedRow = all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM pipeline_runs
        WHERE domain = ? AND status = 'failed' AND ended_at >= ?`,
      d.domain, sinceEpoch,
    )
    const failed24h = failedRow[0]?.n ?? 0
    if (failed24h >= maxPerDay) {
      skipped.push({
        domain: d.domain,
        reason: `cap reached (${failed24h}/${maxPerDay} failed runs in last 24h — needs human review)`,
      })
      continue
    }

    const jobId = runFullPipeline(d.domain, { /* smart-resume from row state */ })
    if (jobId == null) {
      skipped.push({ domain: d.domain, reason: "slot lock rejected" })
      continue
    }
    logPipeline(d.domain, "auto_heal", "running",
      `Auto-retry: status='${d.status}' (failed ${failed24h}/${maxPerDay} in 24h); ` +
      `re-enqueueing pipeline.full with smart-resume`)
    retried.push({ domain: d.domain, status: d.status ?? "", failed_runs_24h: failed24h, job_id: jobId })
  }
  return { retried, skipped }
}

// ---------------------------------------------------------------------------
// 5. Re-fire step 8 for domains that are nominally live/hosted but step 8
//    never actually completed in step_tracker. Catches the failure mode:
//      - step 8 fails (e.g., 1010 zone-pending), pipeline continues
//      - step 9/10 succeed, status flips to hosted
//      - live-checker probes via CF, gets 200 (CF returns SA welcome from
//        origin's default HTTPS vhost), flips status to live
//      - dashboard looks healthy but origin SSL is broken; visitors get
//        the SA welcome page until step 8 actually runs
//
//    Without this, 50 fan-out domains hitting the same race would all be
//    silently broken with no auto-recovery path.
// ---------------------------------------------------------------------------

export interface BrokenSslResult {
  reissued: { domain: string; job_id: number | null }[]
  skipped: { domain: string; reason: string }[]
}

export function autoFixBrokenSsl(): BrokenSslResult {
  const reissued: BrokenSslResult["reissued"] = []
  const skipped: BrokenSslResult["skipped"] = []

  // Per-domain cooldown so an interrupted step 8 (status stuck at 'running'
  // because the worker died mid-flight) doesn't trigger another re-fire on
  // every 5-min sweep. 15 min is enough for one full step-8 attempt + step
  // 10 to wrap up; if step 8 still hasn't reached 'completed' after that,
  // refire is genuinely warranted.
  const cooldownMs = Math.max(
    60_000,
    Number.parseInt(process.env.SSR_AUTOFIX_SSL_COOLDOWN_MS ?? "", 10) || 15 * 60_000,
  )
  // SQLite stores timestamps as "YYYY-MM-DD HH:MM:SS" (space separator) so
  // we MUST match that format for the lexicographic comparison. Using JS's
  // toISOString ("YYYY-MM-DDTHH:MM:SS") would sort space < T and treat
  // every fresh heartbeat as older than the threshold — making the cooldown
  // a no-op and letting auto-heal stomp on freshly-failed runs every tick.
  const cooldownThreshold = new Date(Date.now() - cooldownMs).toISOString().slice(0, 19).replace("T", " ")

  // Domains where step 8 has explicitly FAILED or never ran (NULL row).
  // Excludes:
  //   - status = 'running' (an active worker is on it; piling another
  //     pipeline.full would just queue behind the slot lock)
  //   - status = 'completed' / 'skipped' (already good)
  //   - status = 'warning' if updated recently (step 8 may have soft-
  //     failed and a retry is already in flight via autoRetryRetryable)
  // Cooldown filter prevents tight loops on persistent failures.
  const candidates = all<{ domain: string; step_status: string | null; finished_at: string | null }>(
    `SELECT d.domain, s.status AS step_status, s.finished_at
       FROM domains d
       LEFT JOIN step_tracker s
         ON s.domain = d.domain AND s.step_num = 8
      WHERE d.status IN ('live', 'hosted', 'completed')
        AND (s.status IS NULL OR s.status IN ('failed', 'pending'))`,
  )

  for (const c of candidates) {
    if (isPipelineRunning(c.domain)) {
      skipped.push({ domain: c.domain, reason: "already running" })
      continue
    }
    // Cooldown: if step 8 was attempted recently (any finished_at within
    // the cooldown window), wait. autoRetryRetryable's separate cooldown
    // path also gates retries, so this is belt-and-braces.
    const finishedAt = (c.finished_at ?? "").trim()
    if (finishedAt && finishedAt > cooldownThreshold) {
      skipped.push({
        domain: c.domain,
        reason: `cooldown (step 8 attempted at ${finishedAt}, threshold ${cooldownThreshold})`,
      })
      continue
    }
    const jobId = runFullPipeline(c.domain, { startFrom: 8 })
    if (jobId == null) {
      skipped.push({ domain: c.domain, reason: "slot lock rejected" })
      continue
    }
    logPipeline(c.domain, "auto_heal", "running",
      `Auto-fix broken SSL: step 8 status='${c.step_status ?? "(none)"}' but ` +
      `domain marked live/hosted. Re-firing pipeline.full with start_from=8.`)
    reissued.push({ domain: c.domain, job_id: jobId })
  }
  return { reissued, skipped }
}

// ---------------------------------------------------------------------------
// SA-agent health probe — proactively flags degraded servers
// ---------------------------------------------------------------------------

export interface SaHealthEntry {
  server_id: number
  name: string | null
  ip: string | null
  sa_server_id: string
  status: string  // human-readable: "disconnected" | "offline" | "404" | "error: ..."
}
export interface SaHealthResult {
  checked: number
  degraded: SaHealthEntry[]
}

// ---------------------------------------------------------------------------
// SSL origin-cert sweep — verify every hosted/live domain is still serving
// the CF Origin Cert. Catches the case where SSL install reported success
// but a different cert is on the wire (stale LE auto-cert never replaced,
// silent SSH-fallback that didn't write the conf properly, etc.).
// ---------------------------------------------------------------------------

export interface SslSweepResult {
  checked: number
  mismatched: { domain: string; serverIp: string; subjectCN: string | null; issuer: string | null }[]
  enqueuedReinstalls: { domain: string; jobId: number }[]
}

/**
 * Walk every domain in `hosted` / `live` status with a server attached and
 * TLS-probe its origin IP (SNI=domain). Confirm the issuer is CF Origin CA.
 *
 * Three side-effects per domain:
 *   1. Update `domains.ssl_origin_ok` + `ssl_last_verified_at` so the
 *      Domains page lock-icon column reflects current state without
 *      needing a fresh probe per render.
 *   2. On verified-good: silent (don't spam logs on the happy path).
 *   3. On mismatch: log + audit + dedupe-notify. If auto_migrate_enabled,
 *      enqueue a `pipeline.full` job from step 8 to re-issue + install
 *      the cert on the same server. Per-domain dedupe key prevents
 *      enqueueing repeated retries while one is in flight.
 */
export async function checkOriginCerts(): Promise<SslSweepResult> {
  const rows = all<{ domain: string; server_id: number; current_proxy_ip: string | null }>(
    `SELECT d.domain, d.server_id, s.ip AS current_proxy_ip
       FROM domains d
       JOIN servers s ON s.id = d.server_id
      WHERE d.status IN ('hosted','live') AND s.ip IS NOT NULL`,
  )
  const result: SslSweepResult = { checked: 0, mismatched: [], enqueuedReinstalls: [] }
  if (rows.length === 0) return result

  const { verifyOriginCertIsCustom } = await import("./serveravatar")
  const { updateDomain } = await import("./repos/domains")
  const autoFixEnabled = (getSetting("auto_migrate_enabled") || "0") === "1"
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")

  for (const r of rows) {
    if (!r.current_proxy_ip) continue
    result.checked++
    // Probe with retry-on-mismatch. The SA UI cert install isn't atomic —
    // it writes the CA bundle, triggers an Apache reload (which fails
    // mod_ssl init briefly), then writes the leaf cert + key, then reloads
    // again (which succeeds). For ~30-60s in between, Apache serves the
    // default vhost cert as a fallback. If our verify probe hits that
    // window, we get a false-positive mismatch and trigger ANOTHER install,
    // repeat infinitely. The retry-with-backoff catches the race: by the
    // time the third probe fires (~60s after the first), any in-progress
    // install has settled. Only persistent mismatch reaches the auto-fix.
    let probe
    let probeAttempts = 0
    const RETRY_DELAYS_MS = [15_000, 45_000]  // 0s, +15s, +60s total
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        probeAttempts++
        probe = await verifyOriginCertIsCustom(r.current_proxy_ip, r.domain, 8000)
        if (probe.ok !== false) break
        const nextDelay = RETRY_DELAYS_MS[probeAttempts - 1]
        if (nextDelay === undefined) break
        logPipeline(r.domain, "ssl_verify", "running",
          `Mismatch on probe #${probeAttempts} (might be install-race) — ` +
          `retrying in ${Math.round(nextDelay / 1000)}s before declaring real mismatch.`)
        await new Promise((res) => setTimeout(res, nextDelay))
      }
    } catch (e) {
      logPipeline(r.domain, "ssl_verify", "warning",
        `Origin probe threw: ${(e as Error).message.slice(0, 160)}`)
      continue
    }
    if (probe.ok === true) {
      if (probeAttempts > 1) {
        logPipeline(r.domain, "ssl_verify", "completed",
          `Cert verified on probe #${probeAttempts} — earlier mismatch was an install-race, no fix needed.`)
      }
      updateDomain(r.domain, {
        ssl_origin_ok: 1,
        ssl_last_verified_at: nowIso,
      } as Parameters<typeof updateDomain>[1])
      continue
    }
    if (probe.ok === null) {
      logPipeline(r.domain, "ssl_verify", "warning",
        `Origin probe inconclusive: ${probe.message}`)
      continue
    }
    // probe.ok === false after all retries → genuine mismatch
    updateDomain(r.domain, {
      ssl_origin_ok: 0,
      ssl_last_verified_at: nowIso,
    } as Parameters<typeof updateDomain>[1])
    result.mismatched.push({
      domain: r.domain, serverIp: r.current_proxy_ip,
      subjectCN: probe.subjectCN, issuer: probe.issuerCN,
    })
    logPipeline(r.domain, "ssl_verify", "warning",
      `Origin cert MISMATCH on ${r.current_proxy_ip}: ${probe.message}.`)
    try {
      appendAudit(
        "ssl_origin_mismatch", r.domain,
        `server_id=${r.server_id} ip=${r.current_proxy_ip} ` +
        `subject="${probe.subjectCN ?? "?"}" issuer="${probe.issuerCN ?? "?"}"`,
        null,
      )
    } catch { /* ignore */ }

    // Auto-fix: re-run pipeline from step 8 to re-issue + install SSL on
    // the same server. Skips if a recent in-flight pipeline.full job
    // for this domain is queued or running (avoid stacking retries).
    //
    // Hard cap: if we've already audit-logged N ssl_origin_mismatch entries
    // for this domain in the last 60 min, the install isn't actually
    // fixing the problem — it's a server-side issue (Apache vhost config,
    // SA agent broken, etc.). Stop firing reinstalls forever and surface
    // a hard warning so the operator notices instead of letting it loop
    // overnight burning DO/SA cycles. Reset only when probe.ok=true (the
    // cert actually serves correctly) — that path doesn't reach here.
    if (autoFixEnabled) {
      const MAX_REINSTALLS_PER_HOUR = Number.parseInt(
        process.env.SSR_SSL_MAX_AUTOFIX_PER_HOUR ?? "", 10,
      ) || 3
      const recentMismatches = (one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_log
          WHERE action = 'ssl_origin_mismatch'
            AND target = ?
            AND created_at >= datetime('now', '-60 minutes')`,
        r.domain,
      )?.n ?? 0)
      if (recentMismatches >= MAX_REINSTALLS_PER_HOUR) {
        logPipeline(r.domain, "ssl_verify", "warning",
          `Persistent cert mismatch — ${recentMismatches} in last 60 min. ` +
          `Auto-fix DISABLED for this domain until the issuer flips ` +
          `(reinstall isn't fixing it; check Apache vhost config / SA ` +
          `agent on server #${r.server_id} via apachectl -S).`)
        try {
          appendAudit(
            "ssl_origin_autofix_giveup", r.domain,
            `count=${recentMismatches}/60min  server_id=${r.server_id}  ` +
            `subject="${probe.subjectCN ?? "?"}" issuer="${probe.issuerCN ?? "?"}"`,
            null,
          )
        } catch { /* ignore */ }
        // Skip both the inflight check AND the enqueue — the operator
        // will see the warning + audit entry and intervene manually.
        try {
          const { notify } = await import("./notify")
          await notify(
            `SSL persistent mismatch (${r.domain})`,
            `Auto-fix gave up after ${recentMismatches} re-installs in 60 min ` +
            `did not flip the issuer. Server #${r.server_id} (${r.current_proxy_ip}) ` +
            `is serving "${probe.subjectCN ?? "?"}" instead of CF Origin CA. ` +
            `Likely Apache vhost config or SA agent issue — manual intervention required.`,
            { severity: "error", dedupeKey: `ssl_autofix_giveup:${r.domain}` },
          )
        } catch { /* notify is best-effort */ }
      } else {
        const inflight = all<{ id: number }>(
          `SELECT id FROM jobs
            WHERE kind = 'pipeline.full'
              AND status IN ('queued', 'running')
              AND payload_json LIKE ?`,
          `%"domain":"${r.domain}"%`,
        )
        if (inflight.length === 0) {
          const { enqueueJob } = await import("./jobs")
          const jobId = enqueueJob("pipeline.full", {
            domain: r.domain,
            skip_purchase: true,
            server_id: r.server_id,
            start_from: 8,        // Re-issue + install SSL only
            force_new_server: false,
          }, 1)
          result.enqueuedReinstalls.push({ domain: r.domain, jobId })
          logPipeline(r.domain, "ssl_verify", "running",
            `Auto-fix: enqueued pipeline.full from step 8 (job ${jobId}) ` +
            `to re-install SSL (attempt ${recentMismatches + 1}/${MAX_REINSTALLS_PER_HOUR}).`)
        } else {
          logPipeline(r.domain, "ssl_verify", "warning",
            `Mismatch detected but pipeline.full is already queued/running for this domain — skipping auto-fix to avoid stacking.`)
        }
      }
    }

    try {
      const { notify } = await import("./notify")
      await notify(
        `SSL origin cert wrong: ${r.domain}`,
        `Origin TLS probe at ${r.current_proxy_ip} returned a non-CF certificate:\n` +
        `  subject: ${probe.subjectCN ?? "?"}\n  issuer:  ${probe.issuerCN ?? "?"}\n\n` +
        `${probe.message}\n\n` +
        (autoFixEnabled
          ? `Auto-fix: pipeline.full from step 8 has been queued. Watch /logs.`
          : `Likely fix: enable auto_migrate_enabled, OR manually re-run the pipeline for this domain from step 8.`),
        { severity: "warning", dedupeKey: `ssl_mismatch:${r.domain}` },
      )
    } catch { /* notify is best-effort */ }
  }
  return result
}

// ---------------------------------------------------------------------------
// Stuck-creating server insurance — re-enqueue reinstall_sa if a server has
// been in 'creating' status for too long with no in-flight reinstall job.
// ---------------------------------------------------------------------------

export interface StuckCreatingResult {
  stuck: { server_id: number; name: string | null; ip: string | null }[]
  reEnqueued: { server_id: number; job_id: number }[]
}

/**
 * Detect servers stuck in `status='creating'` for more than `staleMinutes`
 * (default 30) with no currently-running or queued `server.reinstall_sa`
 * job, and re-enqueue one. Covers the case where:
 *   - Migration enqueued reinstall_sa
 *   - Process restarted before the reinstall job claimed the row
 *   - The reinstall_sa was orphan-recovered to 'queued' but then somehow
 *     never got picked up (worker pool stuck, etc.)
 * This is a true insurance net — the migration's enqueue is the primary
 * mechanism; this just catches drops.
 */
export async function recoverStuckCreating(staleMinutes = 30): Promise<StuckCreatingResult> {
  const cutoff = `datetime('now', '-${staleMinutes} minutes')`
  const stuckRows = all<{ id: number; name: string | null; ip: string | null }>(
    `SELECT id, name, ip FROM servers
      WHERE status = 'creating' AND created_at < ${cutoff}`,
  )
  const result: StuckCreatingResult = { stuck: [], reEnqueued: [] }
  if (stuckRows.length === 0) return result

  const { enqueueJob } = await import("./jobs")
  for (const s of stuckRows) {
    result.stuck.push({ server_id: s.id, name: s.name, ip: s.ip })
    // Skip if there's already a reinstall_sa job queued or running for this server.
    const existing = all<{ id: number }>(
      `SELECT id FROM jobs
        WHERE kind = 'server.reinstall_sa'
          AND status IN ('queued', 'running')
          AND payload_json LIKE ?`,
      `%"server_id":${s.id}%`,
    )
    if (existing.length > 0) continue
    const jobId = enqueueJob("server.reinstall_sa", { server_id: s.id }, 1)
    result.reEnqueued.push({ server_id: s.id, job_id: jobId })
    logPipeline(`server-${s.id}`, "reinstall_sa", "running",
      `Stuck-creating insurance: server has been in 'creating' for >${staleMinutes} min ` +
      `with no in-flight reinstall job — auto-enqueueing reinstall_sa (job ${jobId}).`)
  }
  return result
}

/**
 * Walk every `status='ready'` server with a `sa_server_id` and ask SA whether
 * the agent is connected. Domains that still serve HTTPS won't trigger the
 * live-checker's dead-server flow, but if the SA agent is offline the
 * dashboard can't deploy / migrate / install certs — operator needs to know.
 *
 * On finding a degraded server: log to pipeline_log, appendAudit, fire a
 * deduped notify (dedupeKey scoped per-server so the same agent flapping
 * doesn't spam every 5 minutes). This function does NOT auto-mark the
 * server dead or trigger migration — that decision belongs to the operator
 * (they may want to manually reinstall the agent first). live-checker still
 * handles the "HTTPS down too" → mark dead path independently.
 */
export async function checkSaAgents(): Promise<SaHealthResult> {
  const rows = all<{ id: number; name: string | null; ip: string | null; sa_server_id: string }>(
    `SELECT id, name, ip, sa_server_id
       FROM servers
      WHERE status = 'ready' AND sa_server_id IS NOT NULL AND sa_server_id != ''`,
  )
  const degraded: SaHealthEntry[] = []
  if (rows.length === 0) return { checked: 0, degraded }

  const { getServerInfo } = await import("./serveravatar")
  const { notify } = await import("./notify")

  for (const r of rows) {
    let agentStatus = ""
    try {
      const info = await getServerInfo(r.sa_server_id)
      agentStatus = String(info.agent_status ?? info.status ?? "").toLowerCase()
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes("HTTP 404")) {
        agentStatus = "404"
      } else {
        // Transient SA-API failure — skip this row this tick. Log so the
        // operator can see we tried and SA itself was unreachable (vs
        // staying silent which would mask SA-side outages).
        logPipeline(`server-${r.id}`, "sa_health", "warning",
          `SA-info probe failed: ${msg.slice(0, 160)}`)
        continue
      }
    }

    const isDegraded =
      agentStatus === "disconnected" ||
      agentStatus === "offline" ||
      agentStatus === "0" ||
      agentStatus === "404"
    if (!isDegraded) continue

    degraded.push({
      server_id: r.id, name: r.name, ip: r.ip,
      sa_server_id: r.sa_server_id, status: agentStatus,
    })

    const reason = agentStatus === "404"
      ? `SA returned 404 for sa_server_id=${r.sa_server_id} (entry deleted from ServerAvatar)`
      : `SA agent_status='${agentStatus}'`
    logPipeline(`server-${r.id}`, "sa_health", "warning",
      `${reason} — agent appears degraded; HTTPS may still serve but SA-managed actions ` +
      `(deploy, install cert, migrate) will fail. Reinstall agent or migrate.`)
    try {
      appendAudit(
        "sa_agent_degraded",
        `server-${r.id}`,
        `name=${r.name ?? ""} ip=${r.ip ?? ""} sa_server_id=${r.sa_server_id} ` +
        `agent_status=${agentStatus}`,
        null,
      )
    } catch { /* ignore */ }
    try {
      await notify(
        `SA agent degraded: ${r.name ?? `server-${r.id}`}`,
        `${reason}\n\nServer #${r.id} (${r.name ?? "?"} / ${r.ip ?? "?"}).\n` +
        `HTTPS to its domains may still work, but ServerAvatar can't manage it. ` +
        `Reinstall the agent (Servers → click the row → Reinstall agent) or migrate to a fresh droplet.`,
        { severity: "error", dedupeKey: `sa_agent_degraded:${r.id}` },
      )
    } catch { /* notify is best-effort */ }
  }
  return { checked: rows.length, degraded }
}

// ---------------------------------------------------------------------------
// Live + content auto-repair — fires the same reason→step pipeline
// runFromStep(N) the operator gets when they click a DOWN / DEFAULT PAGE
// badge on /domains, but does it on the 5-min auto-heal cadence so the
// fleet self-heals without a human in the loop.
// ---------------------------------------------------------------------------

// Reason → step mapping. KEEP IN SYNC WITH the REPAIR_STEP map in
// app/domains/page.tsx — they encode the same recovery policy. Reasons
// not listed (timeout, connect_refused, fetch_error) need operator
// judgment (migration vs. server-level fix) so we don't auto-fire them.
const AUTOHEAL_REPAIR_STEP: Record<string, number> = {
  dns_fail: 5,    // re-set NS + wait for zone active
  ssl_error: 8,   // re-issue + install SSL
  http_4xx: 10,   // upload index.php
  http_5xx: 7,    // re-create SA app / fix Apache
}

// Per-domain streak of consecutive auto-heal ticks where the row was
// observed as failing. We require 2 consecutive ticks (≥10 min of being
// down) before firing a repair, so a single transient probe failure
// doesn't kick off a 30-second pipeline run.
const liveDownStreak = new Map<string, number>()
const REPAIR_STREAK_THRESHOLD = 2

export interface DownAutoFixResult {
  candidates: number
  fired: { domain: string; reason: string; step: number; jobId: number }[]
  skippedNoMap: { domain: string; reason: string }[]
  skippedInflight: { domain: string }[]
  skippedNotEnoughStreak: { domain: string; streak: number }[]
  skippedDisabled: boolean
}

export async function autoFixDownDomains(): Promise<DownAutoFixResult> {
  const result: DownAutoFixResult = {
    candidates: 0, fired: [], skippedNoMap: [], skippedInflight: [],
    skippedNotEnoughStreak: [], skippedDisabled: false,
  }
  const enabled = (getSetting("auto_migrate_enabled") || "0") === "1"
  if (!enabled) {
    // Same kill switch the SSL auto-fix uses. Operator can disable
    // self-heal entirely without losing the detection signal (badges
    // still flip on /domains; we just don't auto-fire pipelines).
    result.skippedDisabled = true
    return result
  }

  // Two failure modes to repair:
  //   live_ok=0                       → DOWN  (probe failed)
  //   live_ok=1 AND content_ok=0      → DEFAULT PAGE (files weren't deployed)
  // Both end up firing runFromStep(N).
  const rows = all<{
    domain: string
    live_ok: number | null
    live_reason: string | null
    content_ok: number | null
  }>(
    `SELECT domain, live_ok, live_reason, content_ok
       FROM domains
      WHERE status IN ('hosted','live')
        AND (live_ok = 0 OR (live_ok = 1 AND content_ok = 0))`,
  )
  result.candidates = rows.length

  // GC streak entries for domains that are no longer failing — the live-
  // checker writes live_ok=1 on success, so any domain not in this row
  // set must have recovered (or been deleted).
  const failing = new Set(rows.map((r) => r.domain))
  for (const k of liveDownStreak.keys()) {
    if (!failing.has(k)) liveDownStreak.delete(k)
  }
  if (rows.length === 0) return result

  const { enqueueJob } = await import("./jobs")
  for (const r of rows) {
    // DEFAULT PAGE always maps to step 10. DOWN maps via reason; ambiguous
    // reasons (timeout/connect_refused/fetch_error) are skipped.
    const isDefaultPage = r.live_ok === 1 && r.content_ok === 0
    const reason = isDefaultPage ? "default_page" : (r.live_reason ?? "unknown")
    const step = isDefaultPage ? 10 : AUTOHEAL_REPAIR_STEP[reason]
    if (!step) {
      result.skippedNoMap.push({ domain: r.domain, reason })
      continue
    }
    // Streak gating — require N consecutive observations before firing.
    const streak = (liveDownStreak.get(r.domain) ?? 0) + 1
    liveDownStreak.set(r.domain, streak)
    if (streak < REPAIR_STREAK_THRESHOLD) {
      result.skippedNotEnoughStreak.push({ domain: r.domain, streak })
      continue
    }
    // Dedupe against any in-flight pipeline.full job for this domain so
    // we don't stack retries when one is already running.
    const inflight = all<{ id: number }>(
      `SELECT id FROM jobs
        WHERE kind = 'pipeline.full'
          AND status IN ('queued', 'running')
          AND payload_json LIKE ?`,
      `%"domain":"${r.domain}"%`,
    )
    if (inflight.length > 0) {
      result.skippedInflight.push({ domain: r.domain })
      continue
    }
    const jobId = enqueueJob("pipeline.full", {
      domain: r.domain,
      skip_purchase: true,
      server_id: null,
      start_from: step,
      force_new_server: false,
    }, 1)
    result.fired.push({ domain: r.domain, reason, step, jobId })
    logPipeline(r.domain, "auto_heal", "running",
      `Auto-fix: ${reason} (streak=${streak}) → enqueued pipeline.full from step ${step} (job ${jobId})`)
    // Reset streak so a slow-running repair doesn't double-fire on the
    // next tick. The dedupe-against-inflight guard already protects us,
    // but resetting keeps the streak metric meaningful.
    liveDownStreak.set(r.domain, 0)
    try {
      appendAudit("auto_heal_repair", r.domain,
        `reason=${reason} step=${step} job=${jobId}`, null)
    } catch { /* ignore */ }
  }
  return result
}

// ---------------------------------------------------------------------------
// One tick of the background loop
// ---------------------------------------------------------------------------

export interface AutoHealTickResult {
  reconcile: ReconcileResult | { error: string }
  resume: ResumeResult | { error: string }
  ns: NsCheckResult | { error: string }
  retry: RetryResult | { error: string }
  brokenSsl: BrokenSslResult | { error: string }
  saHealth: SaHealthResult | { error: string }
  stuckCreating: StuckCreatingResult | { error: string }
  sslSweep: SslSweepResult | { error: string }
  downAutoFix: DownAutoFixResult | { error: string }
  deadRetry: DeadServerRetryResult | { error: string }
  ranAt: string
}

export async function autoHealTickOnce(): Promise<AutoHealTickResult> {
  const ranAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")

  // Operator pause switch — when settings.auto_heal_paused = '1', the entire
  // tick early-returns. Lets the operator stop a runaway reinstall loop or
  // any other auto-heal misbehavior without restarting the dev server. Read
  // on every tick so toggling it takes effect within one interval (default
  // 5 min).
  try {
    const { getSetting } = await import("./repos/settings")
    if ((getSetting("auto_heal_paused") || "").trim() === "1") {
      return {
        ranAt,
        reconcile: { error: "paused" },
        resume: { error: "paused" },
        ns: { error: "paused" },
        retry: { error: "paused" },
        brokenSsl: { error: "paused" },
        saHealth: { error: "paused" },
        stuckCreating: { error: "paused" },
        sslSweep: { error: "paused" },
        downAutoFix: { error: "paused" },
        deadRetry: { error: "paused" },
      }
    }
  } catch { /* if settings read fails, just proceed normally */ }

  let reconcile: ReconcileResult | { error: string }
  let claimedIds: number[] = []
  try {
    const r = await reconcileOrphanServers()
    reconcile = r
    claimedIds = r.claimed.map((c) => c.id)
  } catch (e) {
    reconcile = { error: (e as Error).message }
  }

  let resume: ResumeResult | { error: string }
  try {
    resume = autoResumeStuckPipelines(claimedIds)
  } catch (e) {
    resume = { error: (e as Error).message }
  }

  let ns: NsCheckResult | { error: string }
  try {
    ns = await autoCheckPendingNs()
  } catch (e) {
    ns = { error: (e as Error).message }
  }

  let retry: RetryResult | { error: string }
  try {
    retry = autoRetryRetryable()
  } catch (e) {
    retry = { error: (e as Error).message }
  }

  let brokenSsl: BrokenSslResult | { error: string }
  try {
    brokenSsl = autoFixBrokenSsl()
  } catch (e) {
    brokenSsl = { error: (e as Error).message }
  }

  let saHealth: SaHealthResult | { error: string }
  try {
    saHealth = await checkSaAgents()
  } catch (e) {
    saHealth = { error: (e as Error).message }
  }

  let stuckCreating: StuckCreatingResult | { error: string }
  try {
    stuckCreating = await recoverStuckCreating()
  } catch (e) {
    stuckCreating = { error: (e as Error).message }
  }

  let sslSweep: SslSweepResult | { error: string }
  try {
    sslSweep = await checkOriginCerts()
  } catch (e) {
    sslSweep = { error: (e as Error).message }
  }

  let downAutoFix: DownAutoFixResult | { error: string }
  try {
    downAutoFix = await autoFixDownDomains()
  } catch (e) {
    downAutoFix = { error: (e as Error).message }
  }

  // Retry servers that are status='dead' AND whose last migration attempt
  // failed. The dead-detect sweep is one-shot per server (skips status!='ready'),
  // so without this a transient provision failure (DO size/region issue, OOM,
  // network blip) leaves the server stuck dead forever even after the operator
  // fixes the underlying config in /settings.
  let deadRetry: DeadServerRetryResult | { error: string }
  try {
    deadRetry = await autoRetryDeadServers()
  } catch (e) {
    deadRetry = { error: (e as Error).message }
  }

  // Daily Claude-Code OAuth sentinel — confirms the operator's
  // CLAUDE_CODE_OAUTH_TOKEN still works before the operator gets surprised
  // by a step-9 failure mid-batch. Self-rate-limits to one ping per 24h
  // (skipped entirely when there's been a successful real call within
  // the same window — saves the API quota).
  let claudeCodeAuth: { status: string; skipped?: boolean; reason?: string } = { status: "skipped" }
  try {
    claudeCodeAuth = await checkClaudeCodeOauthHealth()
  } catch (e) {
    claudeCodeAuth = { status: "error", reason: (e as Error).message }
  }

  // Only audit-log when something actually happened — avoids audit spam.
  const claimedN = "claimed" in reconcile ? reconcile.claimed.length : 0
  const resumedN = "resumed" in resume ? resume.resumed.length : 0
  const nsResumedN = "resumed" in ns ? ns.resumed.length : 0
  const retriedN = "retried" in retry ? retry.retried.length : 0
  const sslReissuedN = "reissued" in brokenSsl ? brokenSsl.reissued.length : 0
  const degradedN = "degraded" in saHealth ? saHealth.degraded.length : 0
  const stuckN = "reEnqueued" in stuckCreating ? stuckCreating.reEnqueued.length : 0
  const sslMismatchedN = "mismatched" in sslSweep ? sslSweep.mismatched.length : 0
  const downRepairsN = "fired" in downAutoFix ? downAutoFix.fired.length : 0
  const deadRetryN = "retried" in deadRetry ? deadRetry.retried.length : 0
  if (claimedN + resumedN + nsResumedN + retriedN + sslReissuedN + degradedN + stuckN + sslMismatchedN + downRepairsN + deadRetryN > 0) {
    appendAudit(
      "auto_heal_tick", "",
      `claimed=${claimedN} resumed=${resumedN} ns_resumed=${nsResumedN} ` +
      `retried=${retriedN} ssl_reissued=${sslReissuedN} sa_degraded=${degradedN} ` +
      `stuck_recovered=${stuckN} ssl_mismatched=${sslMismatchedN} ` +
      `down_repairs=${downRepairsN} dead_retried=${deadRetryN}`,
      null,
    )
  }

  return { reconcile, resume, ns, retry, brokenSsl, saHealth, stuckCreating, sslSweep, downAutoFix, deadRetry, ranAt }
}

// ---------------------------------------------------------------------------
// Dead-server auto-retry — closes the gap left by checkDeadServers being
// one-shot (it only scans status='ready', so a server that flipped to 'dead'
// and then had its migration attempt fail stays stuck forever).
// ---------------------------------------------------------------------------
//
// Trigger: server.status = 'dead' AND auto_migrate_enabled=1 AND last
// migration attempt was either failed/warning OR more than COOLDOWN ago.
//
// Guardrails:
//   - cooldown (default 15 min, env SSR_DEAD_SERVER_RETRY_COOLDOWN_MS) since
//     the previous attempt — gives external services time to recover from a
//     transient outage and the operator time to fix config in /settings
//   - per-server cap (default 6/24h, env SSR_DEAD_SERVER_RETRY_MAX_PER_DAY)
//     — gives up after 24h of trying so we don't burn DO/SA quota on a truly
//     broken case
//   - skips servers with no domains (nothing to migrate; they'll be cleaned
//     up by the post-migration cleanup or a separate sweep)
//   - skips servers where migration is currently in flight (live-checker's
//     in-memory `migrating` Set isn't visible across module boundaries; we
//     use the jobs table as the cross-process source of truth)

export interface DeadServerRetryResult {
  retried: { server_id: number; attempts_24h: number; reason: string }[]
  skipped: { server_id: number; reason: string }[]
}

const DEFAULT_DEAD_RETRY_COOLDOWN_MS = 15 * 60 * 1000
const DEFAULT_DEAD_RETRY_MAX_PER_DAY = 6

export async function autoRetryDeadServers(): Promise<DeadServerRetryResult> {
  const retried: DeadServerRetryResult["retried"] = []
  const skipped: DeadServerRetryResult["skipped"] = []

  // Honor the same enable flag as the initial dead-detect → migrate trigger.
  // No surprise — operator opts in once, both code paths respect it.
  const autoMigrate = (getSetting("auto_migrate_enabled") || "0") === "1"
  if (!autoMigrate) return { retried, skipped }

  const cooldownMs = Math.max(
    60_000,
    Number.parseInt(process.env.SSR_DEAD_SERVER_RETRY_COOLDOWN_MS ?? "", 10) || DEFAULT_DEAD_RETRY_COOLDOWN_MS,
  )
  const maxPerDay = Math.max(
    1,
    Number.parseInt(process.env.SSR_DEAD_SERVER_RETRY_MAX_PER_DAY ?? "", 10) || DEFAULT_DEAD_RETRY_MAX_PER_DAY,
  )

  const dead = all<{ id: number; name: string }>(
    `SELECT id, name FROM servers WHERE status = 'dead'`,
  )
  if (dead.length === 0) return { retried, skipped }

  for (const s of dead) {
    // Has any domain still pointing at this dead server? If not, the prior
    // migration succeeded for all rows and there's nothing left to retry —
    // server is awaiting cleanup, not retry.
    const stillReferencing = (one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM domains WHERE server_id = ? AND status NOT IN ('soft_deleted','deleted','canceled','terminal_error')`,
      s.id,
    )?.n ?? 0)
    if (stillReferencing === 0) {
      skipped.push({ server_id: s.id, reason: "no domains reference this server — awaiting cleanup, not retry" })
      continue
    }

    // Cross-process check: any pipeline.full / domain.bulk_migrate job in
    // flight that targets this server? If so, defer.
    const inflight = (one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM jobs
        WHERE status IN ('queued','running')
          AND (kind = 'pipeline.full' OR kind = 'domain.bulk_migrate')
          AND payload_json LIKE ?`,
      `%"server_id":${s.id}%`,
    )?.n ?? 0)
    if (inflight > 0) {
      skipped.push({ server_id: s.id, reason: "migration already in flight" })
      continue
    }

    // Last attempt time — most recent auto_migrate or migrate log entry for
    // this server's anchor row. Use audit_log's auto_migrate_failed +
    // pipeline_log's migrate/auto_migrate entries; whichever is newest.
    const lastAttempt = one<{ ts: string }>(
      `SELECT created_at AS ts FROM pipeline_log
        WHERE step IN ('auto_migrate','migrate','do_create','sa_install','bulk_migrate')
          AND domain = ?
        ORDER BY id DESC LIMIT 1`,
      `server-${s.id}`,
    )
    const lastTs = lastAttempt?.ts ?? null
    if (lastTs) {
      // SQLite text "YYYY-MM-DD HH:MM:SS" — Date.parse handles it but be
      // explicit about TZ (SQLite stores localish, dashboard convention is
      // UTC). Use unix epoch math on the parsed value.
      const lastMs = new Date(lastTs.includes("T") ? lastTs : lastTs.replace(" ", "T") + "Z").getTime()
      if (Number.isFinite(lastMs) && Date.now() - lastMs < cooldownMs) {
        const minsAgo = Math.round((Date.now() - lastMs) / 60_000)
        skipped.push({ server_id: s.id, reason: `last attempt ${minsAgo}m ago, cooldown=${Math.round(cooldownMs / 60_000)}m` })
        continue
      }
    }

    // Per-day cap — count failed/warning auto_migrate entries in the last
    // 24h. If we've already exhausted retries, give up + leave for operator
    // to manually click "Migrate Now" or investigate.
    const attemptsToday = (one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM pipeline_log
        WHERE domain = ?
          AND step IN ('auto_migrate','do_create','sa_install','bulk_migrate')
          AND status IN ('failed','warning')
          AND created_at >= datetime('now','-24 hours')`,
      `server-${s.id}`,
    )?.n ?? 0)
    if (attemptsToday >= maxPerDay) {
      skipped.push({ server_id: s.id, reason: `${attemptsToday}/${maxPerDay} retries exhausted in 24h — manual intervention needed` })
      continue
    }

    // Fire the retry. spawnMigration is in live-checker.ts but is closure-
    // bound to its own `migrating` Set; safer to call migrateServer directly
    // here (same primitive both code paths use). Run in background — don't
    // block the auto-heal tick (each migration takes 5-15 min).
    void (async () => {
      try {
        const { migrateServer } = await import("./migration")
        logPipeline(`server-${s.id}`, "auto_migrate", "running",
          `Auto-retry: dead server #${s.id} (${s.name}), attempt ${attemptsToday + 1}/${maxPerDay} in 24h`)
        const result = await migrateServer(s.id)
        logPipeline(`server-${s.id}`, "auto_migrate",
          result.failed.length === 0 ? "completed" : "warning",
          `Auto-retry result: ok=${result.ok.length} failed=${result.failed.length}` +
          (result.failed.length > 0 ? ` · ${result.failed.slice(0, 3).map((f) => `${f.domain}(${f.reason.slice(0, 60)})`).join("; ")}` : ""))
      } catch (e) {
        logPipeline(`server-${s.id}`, "auto_migrate", "failed",
          `Auto-retry threw: ${(e as Error).message.slice(0, 200)}`)
      }
    })()
    retried.push({
      server_id: s.id,
      attempts_24h: attemptsToday + 1,
      reason: lastTs ? `last failed ${lastTs}` : "first auto-retry attempt",
    })
  }
  return { retried, skipped }
}

// ---------------------------------------------------------------------------
// Claude Code OAuth token sentinel
// ---------------------------------------------------------------------------
//
// Operator pastes a long-lived OAuth token into Settings → LLM →
// CLAUDE_CODE_OAUTH_TOKEN. Token expires roughly every ~90 days (tied to
// the Pro/Max subscription cycle). When it does, every step-9 call starts
// failing with "Authentication required" — operator notices first when a
// regen they triggered explodes. This sentinel pings the CLI once per 24h
// to detect expiry preemptively + notify with the exact refresh recipe.
//
// Self-rate-limited two ways:
//   1. Skips entirely if no token is configured (operator using API path)
//   2. Skips if a real CLI call succeeded within the last 24h (proven live
//      by real traffic — no need to burn extra quota on a sentinel ping)
//   3. Else pings (~5 tokens of output) at most once per 24h
//
// Persists status to settings (claude_code_oauth_token_status,
// _last_check_at, _last_ok_at) so the Settings UI can show a live badge.
const SENTINEL_INTERVAL_MS = 24 * 60 * 60 * 1000  // 24 hours

export async function checkClaudeCodeOauthHealth(): Promise<{
  status: "ok" | "expired" | "missing" | "skipped" | "error"
  skipped?: boolean
  reason?: string
}> {
  const { getSetting, setSetting } = await import("./repos/settings")
  const token = (getSetting("claude_code_oauth_token") || "").trim()
  if (!token) {
    setSetting("claude_code_oauth_token_status", "missing")
    return { status: "missing", skipped: true, reason: "no token configured" }
  }
  const now = Date.now()
  const lastCheck = getSetting("claude_code_oauth_token_last_check_at") || ""
  const lastOk = getSetting("claude_code_oauth_token_last_ok_at") || ""
  const lastCheckMs = lastCheck ? new Date(lastCheck).getTime() : 0
  const lastOkMs = lastOk ? new Date(lastOk).getTime() : 0
  // Recent real-traffic success proves liveness — skip the probe.
  if (now - lastOkMs < SENTINEL_INTERVAL_MS) {
    return { status: "ok", skipped: true, reason: "recent successful call" }
  }
  // Otherwise, rate-limit to one probe per 24h.
  if (now - lastCheckMs < SENTINEL_INTERVAL_MS) {
    return { status: "skipped", skipped: true, reason: `last probe ${lastCheck}` }
  }
  // Time to ping. Use the smallest, cheapest model + a one-token prompt.
  const { probeLlmCli } = await import("./llm-cli")
  const result = await probeLlmCli("anthropic_cli", "claude-haiku-4-5-20251001")
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
  const prevStatus = (getSetting("claude_code_oauth_token_status") || "unknown").trim()
  setSetting("claude_code_oauth_token_last_check_at", nowIso)
  if (result.ok) {
    setSetting("claude_code_oauth_token_status", "ok")
    setSetting("claude_code_oauth_token_last_ok_at", nowIso)
    return { status: "ok" }
  }
  // Distinguish "binary not on PATH" / "binary not installed" from "token
  // rejected by Claude". The former is an OPERATIONAL issue (install the
  // CLI), not an auth issue — different status + different notify message.
  // Without this branch every fresh server with no `claude` binary would
  // get a misleading "token expired" badge even though the token might be
  // perfectly valid; operator wastes time refreshing a token that's fine.
  const errMsg = result.error ?? ""
  const looksLikeMissingBinary =
    /not found on PATH|ENOENT|claude.*install|binary.*missing/i.test(errMsg)
  if (looksLikeMissingBinary) {
    setSetting("claude_code_oauth_token_status", "binary_missing")
    if (prevStatus !== "binary_missing") {
      try {
        const { notify } = await import("./notify")
        await notify(
          "Claude Code CLI not installed",
          `Sentinel ping couldn't find the claude binary: ${errMsg}\n\n` +
          `On the server, run as root:\n` +
          `  sudo npm install -g @anthropic-ai/claude-code\n\n` +
          `Or use a different provider in Settings → LLM until then.`,
          { severity: "error", dedupeKey: "claude_code_binary_missing" },
        )
      } catch { /* notify is best-effort */ }
    }
    return { status: "expired", reason: errMsg }
  }
  setSetting("claude_code_oauth_token_status", "expired")
  // Notify on transition into expired — once per transition, dedupe key
  // means re-firings during the same broken stretch don't spam.
  if (prevStatus !== "expired") {
    try {
      const { notify } = await import("./notify")
      await notify(
        "Claude Code OAuth token expired (sentinel)",
        `Daily sentinel ping failed: ${errMsg}\n\n` +
        `Refresh on your local machine: run \`claude setup-token\`, copy the ` +
        `sk-ant-oat01-... value, then paste it into Settings → LLM → ` +
        `Claude Code CLI → CLAUDE_CODE_OAUTH_TOKEN.\n\n` +
        `Until refreshed, switch the active provider to a paid API key ` +
        `(Anthropic / OpenAI) or to Cloudflare Workers AI POOL (free).`,
        { severity: "error", dedupeKey: "claude_code_token_expired" },
      )
    } catch { /* notify is best-effort */ }
  }
  return { status: "expired", reason: errMsg }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

// HMR-safe: the timer handle lives on globalThis so module re-evaluation
// (Turbopack edit, Next dev reload) doesn't accidentally spin up a second
// interval alongside the first.
declare global {
  // eslint-disable-next-line no-var
  var __ssrAutoHealTimer: NodeJS.Timeout | null | undefined
  // eslint-disable-next-line no-var
  var __ssrAutoHealStartScheduled: boolean | undefined
}

export function startAutoHeal(): void {
  if (globalThis.__ssrAutoHealTimer || globalThis.__ssrAutoHealStartScheduled) return
  if (process.env.NODE_ENV === "test") return
  if (process.env.SSR_AUTOHEAL === "0") return

  // Default 5 min; min 60s to keep SA + CF API load reasonable.
  const intervalMs = Math.max(
    60_000,
    Number.parseInt(process.env.SSR_AUTOHEAL_INTERVAL_MS ?? "", 10) || 300_000,
  )

  globalThis.__ssrAutoHealStartScheduled = true
  // First tick 60s after boot so init + first request settles before we
  // hit external APIs.
  setTimeout(() => {
    void autoHealTickOnce().catch((e) => {
      const msg = (e as Error).message
      logPipeline("(auto-heal)", "auto_heal", "warning", `tick threw: ${msg}`)
      try { appendAudit("auto_heal_crashed", "", msg, null) } catch { /* ignore */ }
      void import("./notify").then(({ notify }) =>
        notify("Auto-heal tick crashed",
          `autoHealTickOnce threw — sweeper continues but may be in degraded state.\n\n${msg}`,
          { severity: "error", dedupeKey: "auto_heal_crashed" },
        ),
      ).catch(() => { /* notify is best-effort */ })
    })
    const timer = setInterval(() => {
      void autoHealTickOnce().catch((e) => {
        logPipeline("(auto-heal)", "auto_heal", "warning",
          `tick threw: ${(e as Error).message}`)
      })
    }, intervalMs)
    timer.unref?.()
    globalThis.__ssrAutoHealTimer = timer
  }, 60_000).unref?.()
}

export function stopAutoHeal(): void {
  if (globalThis.__ssrAutoHealTimer) {
    clearInterval(globalThis.__ssrAutoHealTimer)
    globalThis.__ssrAutoHealTimer = null
  }
  globalThis.__ssrAutoHealStartScheduled = false
}

// Exported for tests
export const _internal = {
  reconcileOrphanServers,
  autoResumeStuckPipelines,
  autoCheckPendingNs,
  autoHealTickOnce,
  autoFixDownDomains,
}

/** Reset auto-heal in-memory streak state — useful for tests. */
export function _resetAutoHealStreaks(): void {
  liveDownStreak.clear()
}
