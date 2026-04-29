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
import { all } from "./db"

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
// One tick of the background loop
// ---------------------------------------------------------------------------

export interface AutoHealTickResult {
  reconcile: ReconcileResult | { error: string }
  resume: ResumeResult | { error: string }
  ns: NsCheckResult | { error: string }
  retry: RetryResult | { error: string }
  brokenSsl: BrokenSslResult | { error: string }
  ranAt: string
}

export async function autoHealTickOnce(): Promise<AutoHealTickResult> {
  const ranAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")

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

  // Only audit-log when something actually happened — avoids audit spam.
  const claimedN = "claimed" in reconcile ? reconcile.claimed.length : 0
  const resumedN = "resumed" in resume ? resume.resumed.length : 0
  const nsResumedN = "resumed" in ns ? ns.resumed.length : 0
  const retriedN = "retried" in retry ? retry.retried.length : 0
  const sslReissuedN = "reissued" in brokenSsl ? brokenSsl.reissued.length : 0
  if (claimedN + resumedN + nsResumedN + retriedN + sslReissuedN > 0) {
    appendAudit(
      "auto_heal_tick", "",
      `claimed=${claimedN} resumed=${resumedN} ns_resumed=${nsResumedN} ` +
      `retried=${retriedN} ssl_reissued=${sslReissuedN}`,
      null,
    )
  }

  return { reconcile, resume, ns, retry, brokenSsl, ranAt }
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
      logPipeline("(auto-heal)", "auto_heal", "warning",
        `tick threw: ${(e as Error).message}`)
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
}
