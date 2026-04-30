/**
 * Pipeline orchestrator v2 — Node port of modules/pipeline.py.
 *
 * SMART RESUME: detects what's already done and picks up from there.
 * WATCHER: emits step-by-step events so the dashboard shows live progress.
 * SEQUENTIAL: each step must complete before the next runs.
 *
 * Ten steps:
 *   1. Buy / Detect Domain            — Spaceship availability + purchase OR
 *                                       detect bring-your-own (in our SS account
 *                                       OR external registrar).
 *   2. Assign Cloudflare Key          — cf_key_pool picks the next CF account
 *                                       with capacity (20/key default).
 *   3. Create Zone in Cloudflare      — POST /zones; persist cf_zone_id + NS.
 *   4. Set Nameservers                — Spaceship set_nameservers (our account)
 *                                       OR log manual instructions (external).
 *   5. Wait for Zone Active           — Poll up to 2 min; warn-only continuation.
 *   6. Pick / Provision Server        — Use a server with sites_count < max_sites
 *                                       else create a new DO droplet + install SA.
 *   7. Create Site on ServerAvatar    — createApplication + apex+www A record
 *                                       (proxied/orange cloud, SSL=full).
 *   8. Issue & Install Origin SSL     — fetchOriginCaCert (15y) + installCustomSsl
 *                                       (with grey-cloud → orange-cloud restore).
 *   9. Generate Site Content (LLM)    — generateSinglePage (Haiku 4.5 default)
 *                                       with content blocklist + safety scanner.
 *  10. Upload index.php               — uploadIndexPhp via SA File Manager API
 *                                       with SFTP fallback.
 *
 * Concurrency:
 *   - In-process per-domain slot lock prevents two workers running the same
 *     domain simultaneously (user double-click, bulk+single overlap, etc).
 *   - The slot is acquired in the ENQUEUE entry points (so a second click
 *     while a job is queued is rejected immediately) and released in the
 *     worker's finally.
 *
 * Notify + migration callouts (notify_pipeline_failure, archive_site,
 * capture_cf_record_ids, save_origin_cert, read_archive) are wrapped in
 * try/catch so missing modules don't break the pipeline; they become real
 * when those tasks land.
 */

import { addDomain, getDomain, updateDomain, type DomainRow } from "./repos/domains"
import { listServers, updateServer, type ServerRow } from "./repos/servers"
import { logPipeline } from "./repos/logs"
import {
  initSteps, updateStep, heartbeat, setStepArtifact, getStepArtifact,
  startPipelineRun, endPipelineRun, getSteps,
} from "./repos/steps"
import { enqueueJob, registerHandler } from "./jobs"
import {
  checkAvailability, purchaseDomain, setNameservers, listDomains as spaceshipListDomains,
} from "./spaceship"
import {
  createZoneForDomain, getZoneStatus, fetchOriginCaCert, setupDomainDns,
  setDnsARecord, setDnsARecordWww, purgeZoneCache, OriginCaZoneNotActiveError,
} from "./cloudflare"
import {
  createApplication, findAppId, installCustomSsl, uploadIndexPhp,
  installAgentOnDroplet, isSaServerAlive,
} from "./serveravatar"
import { generateSinglePage, ContentBlockedError, type GeneratedFile } from "./website-generator"
import {
  createDroplet, DOAllTokensFailed, DropletRateLimited,
} from "./digitalocean"
import { assignCfKeyToDomain, CFKeyPoolExhausted } from "./cf-key-pool"
import { isErrorStatus, isWaitingStatus, isSuccessStatus } from "./status-taxonomy"
import { createHash } from "node:crypto"
import { one } from "./db"

// ---------------------------------------------------------------------------
// Per-domain slot lock (in-process; pipelines run within one Node process)
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __ssrInflightDomains: Set<string> | undefined
}
function inflight(): Set<string> {
  if (!globalThis.__ssrInflightDomains) globalThis.__ssrInflightDomains = new Set()
  return globalThis.__ssrInflightDomains
}

export function isPipelineRunning(domain: string): boolean {
  return inflight().has(domain)
}

function tryAcquireSlot(domain: string): boolean {
  const s = inflight()
  if (s.has(domain)) return false
  s.add(domain)
  return true
}

function releaseSlot(domain: string): void {
  inflight().delete(domain)
}

// ---------------------------------------------------------------------------
// Cancel handling
// ---------------------------------------------------------------------------

class PipelineCanceled extends Error {
  constructor() { super("PipelineCanceled"); this.name = "PipelineCanceled" }
}

/**
 * Thrown by step 8 when CF Origin CA refuses because the zone is still
 * pending NS propagation. Caller (pipelineWorkerImpl) catches this,
 * reverts domain status to ns_set, and exits cleanly so autoCheckPendingNs
 * can resume from step 5 once the zone activates. NOT a failure — it's
 * "wait, then resume."
 */
class PipelineWaitDns extends Error {
  constructor() { super("PipelineWaitDns"); this.name = "PipelineWaitDns" }
}

function checkCancel(domain: string): void {
  const d = getDomain(domain)
  if (d?.cancel_requested) throw new PipelineCanceled()
}

/**
 * Step-level lock: returns true if step N was already completed (or
 * intentionally skipped) in a prior run AND the operator didn't
 * explicitly target this step via start_from. The caller treats a true
 * return as "skip the heavy work, just record the skip in step_tracker."
 *
 * Intent: a retry after a step-9 failure shouldn't re-do step 8's
 * 1-minute SA UI SSL install, etc. Once a step reaches 'completed' it
 * stays locked across pipeline restarts (see initSteps' preservation
 * of completed/skipped rows).
 *
 * Exception: when the operator hits "Run from step N", they want
 * step N specifically to re-execute even if previously completed —
 * that's the whole point of explicitly choosing it. Steps AFTER N
 * still respect the lock.
 */
function isStepLocked(
  domain: string, stepNum: number, startFrom: number | null | undefined,
): boolean {
  // Operator explicitly chose this exact step → force re-run.
  if (startFrom === stepNum) return false
  const r = stepLockOne<{ status: string }>(
    "SELECT status FROM step_tracker WHERE domain = ? AND step_num = ?",
    domain, stepNum,
  )
  return r?.status === "completed" || r?.status === "skipped"
}

// Local one() to avoid importing from db at top of file (already imported
// further below via `one` from "./db"; alias here for readability).
function stepLockOne<T>(sql: string, ...params: unknown[]): T | undefined {
  return one<T>(sql, ...params)
}

// ---------------------------------------------------------------------------
// Heartbeat ticker — pulses every 1s while a worker runs
// ---------------------------------------------------------------------------

// Local re-export so existing callers in this file keep working. The
// implementation lives in repos/steps.ts so migration / cert-backfill /
// teardown all share the same heartbeat semantics.
import { startHeartbeat } from "./repos/steps"

// ---------------------------------------------------------------------------
// Public entry points (slot-acquired here so double-click is rejected
// immediately, even before the job worker picks it up)
// ---------------------------------------------------------------------------

export interface PipelineFullPayload {
  domain: string
  skip_purchase?: boolean
  server_id?: number | null
  start_from?: number | null
  force_new_server?: boolean
  /** Operator-supplied site brief — when present, step 9 passes it to the
   *  LLM as "Operator brief" so the model uses that niche/style instead of
   *  inferring from the domain name. Only consulted when start_from <= 9. */
  custom_prompt?: string | null
  /** Per-call provider override (e.g. "anthropic", "cloudflare_pool") — for
   *  this run only. Falls back to the global llm_provider setting. */
  custom_provider?: string | null
  /** Per-call model override (e.g. "claude-haiku-4-5-20251001"). Falls back
   *  to the llm_model setting and then per-provider defaults. */
  custom_model?: string | null
}

export interface PipelineBulkPayload {
  domains: string[]
  skip_purchase?: boolean
  server_id?: number | null
  force_new_server?: boolean
  custom_provider?: string | null
  custom_model?: string | null
}

export function runFullPipeline(
  domain: string,
  opts: {
    skipPurchase?: boolean
    serverId?: number | null
    startFrom?: number | null
    forceNewServer?: boolean
    customPrompt?: string | null
    customProvider?: string | null
    customModel?: string | null
  } = {},
): number | null {
  if (!tryAcquireSlot(domain)) {
    logPipeline(domain, "pipeline", "warning",
      "Pipeline start ignored — another run is already in progress")
    return null
  }
  return enqueueJob("pipeline.full", {
    domain,
    skip_purchase: opts.skipPurchase ?? false,
    server_id: opts.serverId ?? null,
    start_from: opts.startFrom ?? null,
    force_new_server: opts.forceNewServer ?? false,
    custom_prompt: opts.customPrompt ?? null,
    custom_provider: opts.customProvider ?? null,
    custom_model: opts.customModel ?? null,
  }, 3)
}

export interface BulkRunResult {
  job_ids: number[]
  /** First job id — kept for the legacy `{ job_id }` response shape some
   *  older callers still expect. Equal to `job_ids[0]` when any were enqueued. */
  job_id: number | null
  enqueued: number
  skipped: number
  /** The actual domains that were queued, preserving input order. Use this
   *  instead of `enqueued` (count) when you need to report back which
   *  specific domains made it past the slot lock. */
  eligible_domains: string[]
}

/**
 * Enqueue ONE `pipeline.full` job per eligible domain so the durable worker
 * pool (default 4 workers, tunable via SSR_JOB_WORKERS) can fan out across
 * domains. Previously this packed everything into a single `pipeline.bulk`
 * job that ran sequentially in one worker — kept the rate-limit blast small
 * but throttled real-world batches to one-at-a-time throughput.
 *
 * Each enqueued job is independent: if one domain fails, the rest keep going;
 * the per-domain slot lock still prevents double-runs of the same domain;
 * cost-cap is now enforced via the worker pool size + the existing
 * `max_droplets_per_hour` setting (DO step) rather than serial execution.
 */
export function runBulkPipeline(
  domains: string[],
  opts: {
    skipPurchase?: boolean
    serverId?: number | null
    forceNewServer?: boolean
    customProvider?: string | null
    customModel?: string | null
  } = {},
): BulkRunResult {
  const eligible: string[] = []
  let skipped = 0
  for (const d of domains) {
    if (tryAcquireSlot(d)) {
      eligible.push(d)
    } else {
      logPipeline(d, "pipeline", "warning",
        "Bulk skip — another pipeline already running for this domain")
      skipped++
    }
  }
  const job_ids: number[] = eligible.map((d) =>
    enqueueJob("pipeline.full", {
      domain: d,
      skip_purchase: opts.skipPurchase ?? false,
      server_id: opts.serverId ?? null,
      start_from: null,
      force_new_server: opts.forceNewServer ?? false,
      custom_provider: opts.customProvider ?? null,
      custom_model: opts.customModel ?? null,
    }, 3),
  )
  return {
    job_ids,
    job_id: job_ids[0] ?? null,
    enqueued: job_ids.length,
    skipped,
    eligible_domains: eligible,
  }
}

/**
 * Sequential variant — enqueues a SINGLE `pipeline.bulk` job that walks
 * the domain list one-by-one in a single worker. Total wall-time is the
 * sum of per-domain durations, but only one external API burst is in
 * flight at a time. Use this when you'd rather keep the rate-limit blast
 * radius small (e.g., a single CF Free key with 5 zones to spend, or
 * when you want a deterministic order to debug a flaky pipeline).
 *
 * Slot lock: acquired for every eligible domain UPFRONT so the caller
 * gets the same "already running → skipped" feedback as the parallel
 * path. Slots are released by `pipelineWorker`'s finally as each domain
 * finishes inside the bulk handler.
 */
export function runSequentialBulkPipeline(
  domains: string[],
  opts: {
    skipPurchase?: boolean
    serverId?: number | null
    forceNewServer?: boolean
    customProvider?: string | null
    customModel?: string | null
  } = {},
): BulkRunResult {
  const eligible: string[] = []
  let skipped = 0
  for (const d of domains) {
    if (tryAcquireSlot(d)) {
      eligible.push(d)
    } else {
      logPipeline(d, "pipeline", "warning",
        "Bulk skip — another pipeline already running for this domain")
      skipped++
    }
  }
  if (eligible.length === 0) {
    return { job_ids: [], job_id: null, enqueued: 0, skipped, eligible_domains: [] }
  }
  const jobId = enqueueJob("pipeline.bulk", {
    domains: eligible,
    skip_purchase: opts.skipPurchase ?? false,
    server_id: opts.serverId ?? null,
    force_new_server: opts.forceNewServer ?? false,
    custom_provider: opts.customProvider ?? null,
    custom_model: opts.customModel ?? null,
  }, 3)
  return {
    job_ids: [jobId],
    job_id: jobId,
    enqueued: eligible.length,
    skipped,
    eligible_domains: eligible,
  }
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

async function pipelineFullHandler(payload: Record<string, unknown>): Promise<void> {
  const p = payload as unknown as PipelineFullPayload
  await pipelineWorker(
    p.domain, p.skip_purchase ?? false, p.server_id ?? null,
    p.start_from ?? null, p.force_new_server ?? false,
    p.custom_prompt ?? null,
    p.custom_provider ?? null,
    p.custom_model ?? null,
  )
}

async function pipelineBulkHandler(payload: Record<string, unknown>): Promise<void> {
  const p = payload as unknown as PipelineBulkPayload
  const failed: { domain: string; reason: string }[] = []
  for (const d of p.domains) {
    try {
      await pipelineWorker(
        d, p.skip_purchase ?? false, p.server_id ?? null,
        null, p.force_new_server ?? false,
        null,
        p.custom_provider ?? null,
        p.custom_model ?? null,
      )
    } catch (e) {
      const reason = `${(e as Error).name}: ${(e as Error).message}`
      failed.push({ domain: d, reason })
      logPipeline(d, "pipeline", "failed",
        `Bulk-worker exception escaped: ${reason}`)
    }
  }
  if (failed.length) {
    logPipeline("", "pipeline", "warning",
      `Bulk run finished with ${failed.length}/${p.domains.length} failures: ` +
      failed.slice(0, 5).map((f) => `${f.domain} (${f.reason})`).join("; ") +
      (failed.length > 5 ? ` and ${failed.length - 5} more` : ""))
  }
}

export function registerPipelineHandlers(): void {
  registerHandler("pipeline.full", pipelineFullHandler)
  registerHandler("pipeline.bulk", pipelineBulkHandler)
}

// ---------------------------------------------------------------------------
// Worker — sets up run row, heartbeat, then dispatches to impl
// ---------------------------------------------------------------------------

async function pipelineWorker(
  domain: string, skipPurchase: boolean, serverId: number | null,
  startFrom: number | null, forceNewServer: boolean,
  customPrompt: string | null = null,
  customProvider: string | null = null,
  customModel: string | null = null,
): Promise<void> {
  const runId = startPipelineRun(domain, {
    skip_purchase: skipPurchase,
    server_id: serverId,
    start_from: startFrom,
  })
  const ticker = startHeartbeat(domain, 1000)
  try {
    await pipelineWorkerImpl(
      domain, skipPurchase, serverId, startFrom, forceNewServer,
      customPrompt, customProvider, customModel,
    )
  } finally {
    ticker.stop()
    // Determine final outcome from the post-run domain status. Order matters:
    // canceled > error > waiting > success > incomplete-fallback.
    try {
      const d = getDomain(domain)
      const ds = d?.status ?? null
      if (ds === "canceled") {
        endPipelineRun(runId, "canceled")
      } else if (isErrorStatus(ds)) {
        endPipelineRun(runId, "failed", ds!)
      } else if (isWaitingStatus(ds)) {
        endPipelineRun(runId, "waiting", ds!)
      } else if (isSuccessStatus(ds)) {
        endPipelineRun(runId, "completed")
      } else {
        endPipelineRun(runId, "failed", `incomplete: exited at status=${ds ?? "null"}`)
      }
    } catch { /* never mask the original error */ }
    try {
      updateDomain(domain, { cancel_requested: 0 } as Parameters<typeof updateDomain>[1])
    } catch { /* ignore */ }
    releaseSlot(domain)
  }
}

async function pipelineWorkerImpl(
  domain: string, skipPurchase: boolean, serverId: number | null, startFrom: number | null,
  forceNewServer: boolean, customPrompt: string | null = null,
  customProvider: string | null = null, customModel: string | null = null,
): Promise<void> {
  try {
    // Refuse to redo work on a domain that's already at a success status
    // (hosted/live) unless the operator explicitly asked for a re-run via
    // start_from. Prevents stale jobs / orphan-recovery / accidental dupes
    // from re-running step 4 (Spaceship NS) and step 5 (CF zone poll, up
    // to 2 min) on a domain that's already serving.
    if (startFrom == null) {
      const existing = getDomain(domain)
      if (existing && isSuccessStatus(existing.status)) {
        logPipeline(domain, "pipeline", "skipped",
          `Pipeline ignored — domain already at success status='${existing.status}'. ` +
          `Pass start_from=N explicitly to force a re-run.`)
        return
      }
    }
    addDomain(domain)
    initSteps(domain)
    logPipeline(domain, "pipeline", "running", "Pipeline v2 started")

    // Per-step lock helper: returns true if the wrapper SHOULD run the
    // step body, false if locked (already completed in a prior run AND
    // operator didn't explicitly target this step via start_from).
    const shouldRun = (n: number): boolean => {
      if (isStepLocked(domain, n, startFrom)) {
        updateStep(domain, n, "skipped",
          "Locked from prior completed run — pass start_from=" + n + " to force re-run")
        return false
      }
      return true
    }

    checkCancel(domain)
    if (startFrom == null || startFrom <= 1) {
      if (shouldRun(1)) {
        if (!await step1BuyOrDetect(domain, skipPurchase)) return
      }
    } else {
      updateStep(domain, 1, "skipped", "start_from > 1")
    }

    checkCancel(domain)
    if (startFrom == null || startFrom <= 2) {
      if (shouldRun(2)) {
        if (!step2AssignCfKey(domain)) return
      }
    }

    checkCancel(domain)
    if (startFrom == null || startFrom <= 3) {
      if (shouldRun(3)) {
        if (!await step3CreateZone(domain)) return
      }
    }

    checkCancel(domain)
    if (startFrom == null || startFrom <= 4) {
      if (shouldRun(4)) {
        if (!await step4SetNameservers(domain)) return
      }
    }

    checkCancel(domain)
    if (startFrom == null || startFrom <= 5) {
      if (shouldRun(5)) {
        await step5WaitZoneActive(domain, 120_000, 15_000)
      }
    }

    checkCancel(domain)
    let server: ServerRow | null
    if (startFrom == null || startFrom <= 6) {
      if (shouldRun(6)) {
        server = await step6GetOrProvisionServer(domain, serverId, forceNewServer)
        if (!server) return
      } else {
        // Step 6 was locked — read the persisted server_id off the
        // domain row (set by the original step 6 run that completed).
        const resumeId = serverId ?? getDomain(domain)?.server_id ?? null
        server = resumeId ? findServer(resumeId) : null
        if (!server) {
          logPipeline(domain, "pipeline", "failed",
            `Step 6 locked but no server_id on domain row — inconsistent state.`)
          updateDomain(domain, { status: "terminal_error" })
          return
        }
      }
    } else {
      const resumeId = serverId ?? getDomain(domain)?.server_id ?? null
      server = resumeId ? findServer(resumeId) : null
      if (!server) {
        logPipeline(domain, "pipeline", "failed",
          `Cannot resume from step ${startFrom}: no server associated. ` +
          `Re-run from step 6 or pick a server explicitly.`)
        updateDomain(domain, { status: "terminal_error" })
        return
      }
    }

    checkCancel(domain)
    if (startFrom == null || startFrom <= 7) {
      if (shouldRun(7)) {
        if (!await step7CreateAppAndDns(domain, server)) return
      }
    }

    checkCancel(domain)
    if (startFrom == null || startFrom <= 8) {
      if (shouldRun(8)) {
        // SSL is warn-on-fail — domain still works on Flexible SSL
        await step8IssueAndInstallSsl(domain, server)
      }
    }

    checkCancel(domain)
    let php: string | null = null
    let files: GeneratedFile[] | undefined
    if (startFrom == null || startFrom <= 9) {
      if (shouldRun(9)) {
        const r = await step9GenerateContent(domain, customPrompt, customProvider, customModel)
        if (r == null) return
        php = r.php
        files = r.files
      } else {
        // Step 9 locked from prior completion — would normally read cached
        // site_html off the domain row. BUT: only the entry-point file is
        // cached there. If the prior run was multi-file, the siblings
        // (style.css, app.js, assets/*) aren't recoverable from the cache,
        // and re-running step 10 alone would re-upload only the index —
        // leaving stale siblings on the SA box (or none at all on a fresh
        // server during migration). When the prior step-9 artifact reports
        // a multi-file output, force regen instead of trusting the cache.
        const last9 = getStepArtifact<{ files?: { path: string }[] | null }>(domain, 9)
        const wasMultiFile = Array.isArray(last9?.files) && (last9!.files!.length > 1)
        if (wasMultiFile) {
          logPipeline(domain, "pipeline", "warning",
            `Prior step 9 produced ${last9!.files!.length} files but only the index ` +
            `is cached — re-running step 9 to restore the full tree`)
          const r = await step9GenerateContent(domain, customPrompt, customProvider, customModel)
          if (r == null) return
          php = r.php
          files = r.files
        } else {
          const d = getDomain(domain)
          php = d?.site_html ?? null
        }
      }
    }
    // If we got here without php (start_from > 9, or step 9 was locked
    // but site_html was cleared somehow), fall back to disk archive then
    // hard-fail with a clear message pointing the operator at step 9.
    if (!php || php.length < 100) {
      const d = getDomain(domain)
      php = d?.site_html ?? null
      if (!php || php.length < 100) {
        try {
          const { readArchive } = await import("./migration")
          const archived = await readArchive(domain)
          if (archived) php = archived.php
        } catch { /* archive missing — fall through */ }
      }
      if (!php || php.length < 100) {
        logPipeline(domain, "pipeline", "failed",
          `Cannot proceed to step 10: no generated content found ` +
          `(site_html empty AND no archive). Re-run from step 9 to regenerate.`)
        updateDomain(domain, { status: "terminal_error" })
        return
      }
    }

    checkCancel(domain)
    if (startFrom == null || startFrom <= 10) {
      if (shouldRun(10)) {
        if (!await step10UploadIndexPhp(domain, server, php!, files)) return
      }
    }

    logPipeline(domain, "pipeline", "completed", `Pipeline v2 complete for ${domain}`)
  } catch (e) {
    if (e instanceof PipelineCanceled) {
      logPipeline(domain, "pipeline", "warning",
        "Pipeline CANCELED by user before completion")
      updateDomain(domain, { status: "canceled", cancel_requested: 0 } as Parameters<typeof updateDomain>[1])
      return
    }
    if (e instanceof PipelineWaitDns) {
      logPipeline(domain, "pipeline", "warning",
        "Pipeline paused at step 8 — waiting for NS propagation. " +
        "autoCheckPendingNs will resume from step 5 once CF marks the zone active.")
      updateDomain(domain, { status: "ns_set" } as Parameters<typeof updateDomain>[1])
      return
    }
    const err = e as Error
    const tb = (err.stack ?? "").slice(0, 4000)
    logPipeline(domain, "pipeline", "failed",
      `Unhandled pipeline error: ${err.name}: ${err.message}\n\n${tb}`)
    updateDomain(domain, { status: "retryable_error" })
    // Operator-facing notification — survives crashes in this catch by
    // being fire-and-forget. Step number is best-effort: pull the most
    // recent non-completed step from step_tracker so the alert is precise.
    void (async () => {
      try {
        const steps = getSteps(domain)
        const inFlight = steps.find((s) => s.status === "running" || s.status === "failed")
        const stepLabel = inFlight ? `${inFlight.step_num} (${inFlight.step_name})` : "?"
        const { notifyPipelineFailure } = await import("./notify")
        await notifyPipelineFailure(domain, stepLabel, `${err.name}: ${err.message}`)
      } catch { /* notify is best-effort */ }
    })()
  }
}

// ============================================================================
// Step implementations
// ============================================================================

async function step1BuyOrDetect(domain: string, skipPurchase: boolean): Promise<boolean> {
  const d = getDomain(domain)
  if (d && (d.status === "purchased" || d.status === "owned" ||
            (d.status !== "pending" && d.status !== null && d.status !== undefined))) {
    updateStep(domain, 1, "skipped", `Already: ${d.status}`)
    return true
  }
  updateStep(domain, 1, "running", "Checking domain availability / ownership...")
  let isAvailable = false
  try {
    const avail = await checkAvailability(domain)
    const entries = avail.domains ?? []
    const info = entries.find((e) => (e.name ?? "").toLowerCase() === domain.toLowerCase()) ?? entries[0]
    isAvailable = Boolean(info?.isAvailable)
  } catch (e) {
    updateStep(domain, 1, "failed", `availability check failed: ${(e as Error).message}`)
    updateDomain(domain, { status: "retryable_error" })
    return false
  }

  if (isAvailable) {
    if (skipPurchase) {
      updateStep(domain, 1, "warning",
        "Domain is available but skip_purchase=true — please buy it manually, then rerun")
      updateDomain(domain, { status: "pending" })
      return false
    }
    updateStep(domain, 1, "running", `${domain} is available — purchasing via Spaceship...`)
    const r = await purchaseDomain(domain)
    if (!r.ok) {
      updateStep(domain, 1, "failed", `purchase failed: ${String(r.result).slice(0, 200)}`)
      updateDomain(domain, { status: "purchase_failed" })
      return false
    }
    updateStep(domain, 1, "completed", "Purchased via Spaceship")
    updateDomain(domain, { status: "purchased" })
    return true
  }

  // Unavailable — is it in our Spaceship account? Paginate (cap 25/page)
  let foundHere = false
  try {
    let skip = 0
    for (let page = 0; page < 40; page++) {
      const resp = await spaceshipListDomains(25, skip) as { items?: { name?: string }[]; data?: { name?: string }[] }
      const items = resp.items ?? resp.data ?? []
      if (items.some((it) => (it.name ?? "").toLowerCase() === domain.toLowerCase())) {
        foundHere = true; break
      }
      if (items.length < 25) break
      skip += 25
    }
  } catch (e) {
    logPipeline(domain, "detect", "warning",
      `Spaceship list_domains paging stopped: ${(e as Error).message}`)
  }
  if (foundHere) {
    updateStep(domain, 1, "completed", "Bring-your-own (found in Spaceship account)")
    updateDomain(domain, { status: "owned" })
    return true
  }

  updateStep(domain, 1, "warning",
    "Domain is registered elsewhere. We'll still create the CF zone; " +
    "you must manually update NS at your registrar when we reach step 4.")
  updateDomain(domain, { status: "owned_external" })
  return true
}

function step2AssignCfKey(domain: string): boolean {
  const d = getDomain(domain)
  if (d?.cf_key_id) {
    updateStep(domain, 2, "skipped", `CF key already assigned: ${d.cf_email}`)
    return true
  }
  updateStep(domain, 2, "running", "Picking next CF key from pool...")
  try {
    const key = assignCfKeyToDomain(domain)
    updateStep(domain, 2, "completed",
      `Assigned ${key.alias || key.email} (used ${key.domains_used}/${key.max_domains})`)
    setStepArtifact(domain, 2, {
      cf_key_id: key.id, cf_key_alias: key.alias, cf_email: key.email,
      domains_used: key.domains_used, max_domains: key.max_domains,
    })
    updateDomain(domain, { status: "cf_assigned" })
    return true
  } catch (e) {
    if (e instanceof CFKeyPoolExhausted) {
      updateStep(domain, 2, "failed", `CF key pool exhausted: ${e.message}`)
      updateDomain(domain, { status: "cf_pool_full" })
      logPipeline(domain, "pipeline", "failed",
        "CF key pool full — add a new CF key in dashboard and re-run")
      void (async () => {
        try {
          const { notify } = await import("./notify")
          await notify(
            "CF key pool exhausted",
            `Pipeline for ${domain} blocked at step 2: ${e.message}\n\n` +
            `Add a new CF key in the dashboard. Auto-heal will pick up the backlog ` +
            `once a key has free slots.`,
            { severity: "error", dedupeKey: "cf_pool_exhausted" },
          )
        } catch { /* notify is best-effort */ }
      })()
      return false
    }
    updateStep(domain, 2, "failed", (e as Error).message)
    updateDomain(domain, { status: "retryable_error" })
    return false
  }
}

async function step3CreateZone(domain: string): Promise<boolean> {
  const d = getDomain(domain)
  if (d?.cf_zone_id && d.cf_nameservers) {
    updateStep(domain, 3, "skipped", `Zone already exists: ${d.cf_zone_id}`)
    return true
  }
  updateStep(domain, 3, "running", "Adding zone to Cloudflare...")
  try {
    const info = await createZoneForDomain(domain)
    updateStep(domain, 3, "completed",
      `zone=${info.zone_id.slice(0, 12)}… NS=${info.nameservers.join(",")}`)
    setStepArtifact(domain, 3, { cf_zone_id: info.zone_id, cf_nameservers: info.nameservers })
    updateDomain(domain, { status: "zone_created" })
    return true
  } catch (e) {
    updateStep(domain, 3, "failed", (e as Error).message.slice(0, 400))
    updateDomain(domain, { status: "retryable_error" })
    return false
  }
}

async function step4SetNameservers(domain: string): Promise<boolean> {
  const d = getDomain(domain)
  if (!d || !d.cf_nameservers) {
    updateStep(domain, 4, "failed", "No cf_nameservers set on domain row")
    updateDomain(domain, { status: "retryable_error" })
    return false
  }
  const nameservers = d.cf_nameservers.split(",").map((n) => n.trim()).filter(Boolean)
  if (d.status === "owned_external") {
    updateStep(domain, 4, "warning",
      `Manual action required at external registrar: set NS to ${nameservers.join(", ")}`)
    updateDomain(domain, { status: "ns_pending_external" })
    return true
  }
  updateStep(domain, 4, "running", `Setting NS on Spaceship: ${nameservers.join(", ")}`)
  try {
    const ok = await setNameservers(domain, nameservers)
    if (!ok) {
      updateStep(domain, 4, "failed", "Spaceship setNameservers returned false")
      updateDomain(domain, { status: "retryable_error" })
      return false
    }
    updateStep(domain, 4, "completed", `NS updated: ${nameservers.join(", ")}`)
    updateDomain(domain, { status: "ns_set" })
    return true
  } catch (e) {
    updateStep(domain, 4, "failed", (e as Error).message.slice(0, 400))
    updateDomain(domain, { status: "retryable_error" })
    return false
  }
}

async function step5WaitZoneActive(domain: string, timeoutMs = 600_000, pollMs = 30_000): Promise<boolean> {
  const d = getDomain(domain)
  // Already past zone-active means status moved to app_created, ssl_installed,
  // hosted, or live — any of those means step 5 is implicitly done.
  if (d && (d.status === "zone_active" || d.status === "app_created" || isSuccessStatus(d.status))) {
    updateStep(domain, 5, "skipped", "Zone already active")
    return true
  }
  updateStep(domain, 5, "running", "Polling Cloudflare zone status...")
  const start = Date.now()
  const deadline = start + timeoutMs
  while (Date.now() < deadline) {
    try {
      const s = await getZoneStatus(domain)
      if (s === "active") {
        updateStep(domain, 5, "completed", "Zone ACTIVE")
        updateDomain(domain, { status: "zone_active" })
        return true
      }
      const elapsed = Math.floor((Date.now() - start) / 1000)
      updateStep(domain, 5, "running",
        `Zone status: ${s}  (${elapsed}s/${Math.floor(timeoutMs / 1000)}s)`)
    } catch { /* ignore transient */ }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  updateStep(domain, 5, "warning",
    `Zone not active after ${Math.floor(timeoutMs / 1000)}s — continuing; may need re-run later`)
  return false
}

async function step6GetOrProvisionServer(
  domain: string, explicitServerId: number | null, forceNew = false,
): Promise<ServerRow | null> {
  if (!forceNew) {
    const existing = findServer(explicitServerId)
    if (existing) {
      updateStep(domain, 6, "completed",
        `Using existing server #${existing.id} ${existing.name} (${existing.ip})  ` +
        `sites=${existing.sites_count}/${existing.max_sites}`)
      setStepArtifact(domain, 6, {
        source: "existing", server_id: existing.id,
        server_name: existing.name, server_ip: existing.ip,
        sa_server_id: existing.sa_server_id,
      })
      return existing
    }
  }

  updateStep(domain, 6, "running",
    forceNew
      ? "Operator requested new server — provisioning DO droplet..."
      : "No server with capacity — provisioning new DO droplet...")
  try {
    const { generateServerName } = await import("./server-names")
    const gen = await generateServerName()
    const serverName = gen.name
    if (gen.lookup_errors.length > 0) {
      logPipeline(domain, "name_gen", "warning",
        `Name picked '${serverName}' but uniqueness check had errors on: ` +
        gen.lookup_errors.map((e) => `${e.source}=${e.error.slice(0, 60)}`).join("; "))
    } else {
      logPipeline(domain, "name_gen", "running",
        `Server name '${serverName}' (db=${gen.used_counts.db} sa=${gen.used_counts.sa} ` +
        `do_primary=${gen.used_counts.do_primary} do_backup=${gen.used_counts.do_backup} reserved)`)
    }
    const { serverId, ip, dropletId } = await createDroplet({ name: serverName })
    updateStep(domain, 6, "running",
      `Droplet ${dropletId} up at ${ip} — installing ServerAvatar agent (5-15 min)...`)
    const saServerId = await installAgentOnDroplet({
      dropletIp: ip,
      serverName,
      onProgress: (msg) => updateStep(domain, 6, "running", msg),
    })
    updateServer(serverId, { sa_server_id: saServerId, status: "ready" })
    // Persist domain → server link NOW (not later in step 7) so a crash
    // between this point and step 7's link write doesn't strand the smart-
    // resume path: auto-heal's autoResumeStuckPipelines reads
    // getDomain(domain).server_id to find the server when retrying. Before
    // this, a kill mid-step-7 left the domain row with server_id=null and
    // the operator had to manually associate the server.
    updateDomain(domain, { server_id: serverId } as Parameters<typeof updateDomain>[1])
    updateStep(domain, 6, "completed",
      `Provisioned server #${serverId} ${serverName} (${ip})  sa_id=${saServerId}`)
    setStepArtifact(domain, 6, {
      source: "provisioned", server_id: serverId, server_name: serverName,
      server_ip: ip, sa_server_id: saServerId, do_droplet_id: dropletId,
    })
    return findServer(serverId)
  } catch (e) {
    if (e instanceof DOAllTokensFailed) {
      const msg = `Provisioning failed: all DO tokens rejected the request. ` +
        `Attempts: ${e.attempts.map(([lbl, err]) => `${lbl}→${err}`).join("; ")}`
      updateStep(domain, 6, "failed", msg)
      logPipeline(domain, "provision", "failed", msg)
      updateDomain(domain, { status: "retryable_error" })
      void (async () => {
        try {
          const { notifyDoAllFailed } = await import("./notify")
          await notifyDoAllFailed(`step 6 (${domain})`, e.attempts)
        } catch { /* notify is best-effort */ }
      })()
      return null
    }
    if (e instanceof DropletRateLimited) {
      const msg = `Droplet creation refused by cost cap: ${e.message}`
      updateStep(domain, 6, "failed", msg)
      logPipeline(domain, "provision", "failed", msg)
      updateDomain(domain, { status: "retryable_error" })
      return null
    }
    updateStep(domain, 6, "failed", `Provisioning failed: ${(e as Error).message}`)
    logPipeline(domain, "provision", "failed", (e as Error).message)
    // Without this, the domain row stays at whatever step 4 set (ns_set),
    // making the failure invisible to auto-heal's autoResumeStuckPipelines
    // filter (which watches for retryable_error). Steps 3/4/7/8/9/10 all set
    // this on their failure paths — step 6 was the lone outlier.
    updateDomain(domain, { status: "retryable_error" })
    return null
  }
}

async function step7CreateAppAndDns(domain: string, server: ServerRow): Promise<boolean> {
  const d = getDomain(domain)
  if (d && (d.status === "app_created" || d.status === "ssl_installed" || d.status === "live") &&
      d.current_proxy_ip === server.ip) {
    updateStep(domain, 7, "skipped", "App already exists + DNS already set")
    return true
  }

  updateStep(domain, 7, "running", `Creating SA app for ${domain} on ${server.name}...`)
  let appId: string
  try {
    appId = await createApplication(server.sa_server_id!, domain)
  } catch (e) {
    // SA refuses duplicate apps with this validation message. Treat as
    // "already there" — look up the existing app id and continue. Mirrors
    // the same idempotent-on-create pattern step 3 (CF zone) uses.
    const msg = (e as Error).message
    const isDup = /already exists/i.test(msg) ||
      /Application name already exists/i.test(msg) ||
      /Application domain already exists/i.test(msg)
    if (isDup) {
      try {
        const existing = await findAppId(server.sa_server_id!, domain)
        if (!existing) {
          updateStep(domain, 7, "failed",
            `SA says app exists but findAppId returned null: ${msg}`)
          updateDomain(domain, { status: "retryable_error" })
          return false
        }
        appId = existing
        logPipeline(domain, "sa_create_app", "warning",
          `App ${appId} already exists on SA — reusing instead of failing`)
      } catch (lookupErr) {
        updateStep(domain, 7, "failed",
          `SA app exists but findAppId threw: ${(lookupErr as Error).message}`)
        updateDomain(domain, { status: "retryable_error" })
        return false
      }
    } else {
      updateStep(domain, 7, "failed", `SA createApplication: ${msg}`)
      updateDomain(domain, { status: "retryable_error" })
      return false
    }
  }
  updateDomain(domain, { server_id: server.id })

  updateStep(domain, 7, "running", `Setting DNS A records → ${server.ip} (proxied)`)
  try {
    await setupDomainDns(domain, server.ip!)
  } catch (e) {
    updateStep(domain, 7, "failed", `CF DNS setup: ${(e as Error).message}`)
    updateDomain(domain, { status: "retryable_error" })
    return false
  }

  updateDomain(domain, { status: "app_created", current_proxy_ip: server.ip } as Parameters<typeof updateDomain>[1])
  setStepArtifact(domain, 7, {
    sa_app_id: appId, server_id: server.id, server_ip: server.ip, proxied: true,
  })
  // Cache CF apex+www A-record IDs so a future migration can PATCH them in
  // O(1) instead of list+search. Non-fatal on failure.
  try {
    const { captureCfRecordIds } = await import("./migration")
    await captureCfRecordIds(domain)
  } catch (e) {
    logPipeline(domain, "cf_record_capture", "warning",
      `Could not cache record IDs (non-fatal): ${(e as Error).message}`)
  }

  updateStep(domain, 7, "completed",
    `App id=${appId} created + DNS → ${server.ip} (orange cloud)`)
  return true
}

async function step8IssueAndInstallSsl(domain: string, server: ServerRow): Promise<boolean> {
  // Note: idempotency / lock is handled by the wrapper-level isStepLocked
  // check in pipelineWorkerImpl. By the time this function runs, the
  // wrapper has already confirmed step 8 isn't already-completed.

  updateStep(domain, 8, "running", "Issuing Origin CA cert (15y) from Cloudflare...")
  let bundle: { certificate: string; private_key: string; chain: string; id: string; expires_on: string }
  try {
    bundle = await fetchOriginCaCert(domain)
  } catch (e) {
    // Pending-zone case: throw PipelineWaitDns so the worker exits the
    // entire pipeline cleanly instead of continuing through steps 9-10
    // (which would set status='hosted' and shadow our ns_set revert,
    // making autoCheckPendingNs skip this domain). The worker catches
    // this and reverts status to ns_set; autoCheckPendingNs resumes
    // from step 5 once NS propagation completes.
    if (e instanceof OriginCaZoneNotActiveError) {
      updateStep(domain, 8, "warning",
        "Origin CA refused — zone still pending NS propagation. " +
        "Pipeline will resume from step 5 once CF marks the zone active.")
      throw new PipelineWaitDns()
    }
    updateStep(domain, 8, "warning", `Origin CA issuance failed: ${(e as Error).message}`)
    return false
  }

  // Persist cert + key on the domain row so a future migration can reuse them
  try {
    const { saveOriginCert } = await import("./migration")
    saveOriginCert(domain, bundle.certificate, bundle.private_key)
  } catch (e) {
    logPipeline(domain, "origin_cert_cache", "warning",
      `Could not cache cert (non-fatal): ${(e as Error).message}`)
  }

  // Grey-cloud briefly so SA's auto-LE verification can resolve to the origin IP
  updateStep(domain, 8, "running",
    "Temporarily grey-clouding DNS for SA SSL verification...")
  try {
    await setDnsARecord(domain, server.ip!, false)
    await setDnsARecordWww(domain, server.ip!, false)
    await new Promise((r) => setTimeout(r, 30_000))
  } catch (e) {
    logPipeline(domain, "cf_grey_cloud", "warning", `grey-cloud failed: ${(e as Error).message}`)
  }

  let installOk = false
  let installMsg = ""
  try {
    const appId = await findAppId(server.sa_server_id!, domain)
    if (!appId) throw new Error("App not found on SA server for SSL install")
    const r = await installCustomSsl({
      saServerId: server.sa_server_id!,
      appId,
      certificatePem: bundle.certificate,
      privateKeyPem: bundle.private_key,
      chainPem: bundle.chain,
      forceHttps: true,
      domain,
      serverIp: server.ip!,
    })
    installOk = r.ok
    installMsg = r.message
  } catch (e) {
    installMsg = `install error: ${(e as Error).message}`
  } finally {
    // ALWAYS restore the orange cloud, even if install errored
    try {
      await setDnsARecord(domain, server.ip!, true)
      await setDnsARecordWww(domain, server.ip!, true)
    } catch (e) {
      logPipeline(domain, "cf_orange_cloud_restore", "failed",
        `could not re-enable proxy: ${(e as Error).message}`)
    }
  }

  if (installOk) {
    // Defensive verification — TLS-probe the origin IP and confirm the cert
    // serving is actually our CloudFlare Origin CA, not SA's auto-issued
    // Let's Encrypt. Catches the failure mode where the API/UI tier reports
    // success but a stale LE cert remained on the SA box (the "treats SA's
    // own SSL as completed" symptom). Probe failure is non-fatal — we don't
    // break working pipelines on a transient network blip.
    const { verifyOriginCertIsCustom } = await import("./serveravatar")
    const verify = await verifyOriginCertIsCustom(server.ip!, domain)
    if (verify.ok === false) {
      // Cert IS serving but with the wrong issuer (LE on origin → step
      // didn't actually replace it). Surface as warning so Run-from-here
      // shows the retry button.
      updateStep(domain, 8, "warning",
        `SSL install reported success BUT cert verification failed: ${verify.message}. ` +
        `Installer message: ${installMsg}. Click "Run from here" on step 8 to retry.`)
      updateDomain(domain, { status: "retryable_error" })
      return false
    }
    const verifyNote = verify.ok === true
      ? ` · cert ${verify.message}`
      : ` · cert verify skipped (${verify.message})`
    updateStep(domain, 8, "completed", `SSL installed (${installMsg})${verifyNote}`)
    updateDomain(domain, { status: "ssl_installed" })
    setStepArtifact(domain, 8, {
      cert_id: bundle.id, expires_on: bundle.expires_on,
      verified_issuer: verify.issuerCN ?? null,
      verified: verify.ok === true,
    })
    // Purge CF cache. Origin SSL just changed — any cached "SA welcome"
    // response from CF's earlier fetch through the broken HTTPS vhost
    // would otherwise persist for hours.
    void purgeZoneCache(domain).catch(() => { /* logged inside */ })
    return true
  }
  updateStep(domain, 8, "warning",
    `SA SSL install failed: ${installMsg}  — site still reachable ` +
    `(CF is orange-clouded, cert may be installed via SSH fallback)`)
  return false
}

async function step9GenerateContent(
  domain: string, customPrompt: string | null = null,
  customProvider: string | null = null, customModel: string | null = null,
): Promise<{ php: string; files?: GeneratedFile[] } | null> {
  const d = getDomain(domain)
  // When the operator supplied a custom brief OR explicitly chose a different
  // provider/model (force-rerun via the brief dialog), ALWAYS run the LLM —
  // the cached site_html was generated under different params, so the
  // operator clearly wants a redo.
  const hasOverrides = Boolean(customPrompt || customProvider || customModel)
  if (!hasOverrides && d?.site_html && d.site_html.length > 100) {
    updateStep(domain, 9, "skipped", "Content already generated")
    // Note: no `files` here — multi-file siblings aren't cached on the
    // domain row. Step 10 will re-upload only the index. Same effect as
    // pre-multi-file pipelines: rerunning step 10 alone touches index only.
    return { php: d.site_html }
  }
  const briefNote = [
    customPrompt ? "custom brief" : null,
    customProvider ? `provider=${customProvider}` : null,
    customModel ? `model=${customModel}` : null,
  ].filter(Boolean).join(", ")
  const note = briefNote ? ` (${briefNote})` : ""
  updateStep(domain, 9, "running", `Generating single-page site${note}...`)
  try {
    const result = await generateSinglePage(domain, {
      customPrompt, customProvider, customModel,
    })
    const php = result.php
    const niche = result.inferredNiche
    updateDomain(domain, { site_html: php })
    // When the LLM refused and the static "Coming Soon" placeholder was
    // substituted, mark the step "warning" so the dashboard's existing
    // Run-from-here button surfaces on the timeline (it's hidden on
    // "completed" steps to avoid noise on healthy pipelines). Pipeline
    // still continues — the site is LIVE with the placeholder.
    if (result.usedFallback) {
      updateStep(domain, 9, "warning",
        `Placeholder used — LLM refused for this domain (niche='${niche}'). ` +
        `Click "Run from here" on step 9 to retry, change provider/model, or accept placeholder.`)
    } else if (result.files && result.files.length > 1) {
      updateStep(domain, 9, "completed",
        `Generated (niche='${niche}'  files=${result.files.length}: ` +
        `${result.files.map((f) => f.path).join(", ").slice(0, 240)})`)
    } else {
      updateStep(domain, 9, "completed", `Generated (niche='${niche}'  bytes=${php.length})`)
    }
    setStepArtifact(domain, 9, {
      niche, byte_size: php.length,
      sha256: createHash("sha256").update(php, "utf8").digest("hex"),
      placeholder: Boolean(result.usedFallback),
      files: result.files?.map((f) => ({ path: f.path, bytes: f.content.length })) ?? null,
    })
    return { php, files: result.files }
  } catch (e) {
    if (e instanceof ContentBlockedError) {
      updateStep(domain, 9, "failed",
        `CONTENT BLOCKED — niche='${e.inferredNiche}'  reason=${e.reason}`)
      updateDomain(domain, { status: "content_blocked" })
      logPipeline(domain, "pipeline", "blocked", `Blocked: ${e.reason}`)
      return null
    }
    updateStep(domain, 9, "failed", `LLM error: ${(e as Error).message}`)
    updateDomain(domain, { status: "retryable_error" })
    return null
  }
}

async function step10UploadIndexPhp(
  domain: string, server: ServerRow, php: string, files?: GeneratedFile[],
): Promise<boolean> {
  const isMultiFile = Boolean(files && files.length > 1)
  updateStep(domain, 10, "running",
    isMultiFile
      ? `Writing ${files!.length} files to ${server.name}...`
      : `Writing index.php to ${server.name}...`)
  try {
    if (isMultiFile) {
      const { uploadAppFiles } = await import("./serveravatar")
      await uploadAppFiles(server.sa_server_id!, domain, files!, server.ip ?? undefined)
    } else {
      await uploadIndexPhp(server.sa_server_id!, domain, php, server.ip ?? undefined)
    }

    // Archive the entry-point file locally so dead-server migration can
    // re-upload it without paying the LLM or waiting on regeneration.
    // For multi-file sites, only the index is archived — siblings will be
    // regenerated on migration. (Future improvement: archive the whole tree.)
    try {
      const { archiveSite } = await import("./migration")
      await archiveSite(domain, php)
    } catch (e) {
      logPipeline(domain, "archive", "warning",
        `Archive save failed (non-fatal): ${(e as Error).message}`)
    }

    updateDomain(domain, { status: "hosted" })
    updateStep(domain, 10, "completed",
      `Hosted on ${server.ip}. Dashboard will flip to 'live' ` +
      `once https://${domain}/ responds (usually a few min).`)
    setStepArtifact(domain, 10, {
      server_ip: server.ip, server_id: server.id, byte_size: php.length,
      multi_file: isMultiFile, file_count: files?.length ?? 1,
    })
    // Purge CF cache so visitors immediately see the new content. Without
    // this, CF can keep serving the SA welcome page (cached during step 7)
    // for hours. Best-effort — content is on origin either way.
    void purgeZoneCache(domain).catch(() => { /* logged inside */ })
    return true
  } catch (e) {
    updateStep(domain, 10, "failed", (e as Error).message)
    updateDomain(domain, { status: "retryable_error" })
    return false
  }
}

// ---------------------------------------------------------------------------
// Server selection — explicit id wins, else round-robin eligible servers
// ---------------------------------------------------------------------------

function findServer(explicitId: number | null | undefined): ServerRow | null {
  const servers = listServers()
  if (explicitId) {
    const s = servers.find((x) => x.id === Number(explicitId))
    if (!s) return null
    return verifySaServerOrMarkDead(s) ? s : null
  }
  const eligible = servers.filter(
    (s) => s.status === "ready" && s.sa_server_id &&
      (s.sites_count ?? 0) < (s.max_sites ?? 60),
  )
  // Fisher-Yates shuffle for round-robin distribution
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[eligible[i], eligible[j]] = [eligible[j], eligible[i]]
  }
  for (const s of eligible) {
    if (verifySaServerOrMarkDead(s)) return s
  }
  return null
}

/**
 * Sync verifier — flips a server row to status='dead' when SA returns 404.
 * Uses a fire-and-forget async probe; this is best-effort (we accept the
 * server on network glitches just like Flask does, then the next call sees
 * the eventual 'dead' state).
 *
 * NOTE: returns synchronously based on the LAST KNOWN state stored in the
 * row. The actual SA probe runs async and writes the 'dead' status if the
 * server is gone — picked up on the next pipeline pass.
 */
function verifySaServerOrMarkDead(server: ServerRow): boolean {
  if (!server.sa_server_id) return false
  // Kick off background verification — non-blocking
  void (async () => {
    try {
      const alive = await isSaServerAlive(server.sa_server_id!)
      if (!alive) {
        updateServer(server.id, { status: "dead" } as Parameters<typeof updateServer>[1])
        logPipeline(`server-${server.id}`, "sa_health", "warning",
          `Server #${server.id} (${server.name} / ${server.ip}) flipped to DEAD — ` +
          `SA no longer has sa_server_id=${server.sa_server_id}`)
      }
    } catch { /* network glitch — leave row alone */ }
  })()
  // Trust the row's current status — if it was 'dead' we'd have filtered it out above.
  return true
}

// Re-export for the router
export type { DomainRow }
