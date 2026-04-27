/**
 * Domain status taxonomy + helpers — Node port of database.py constants.
 *
 * Single source of truth for what each status means. Pipeline / live-checker /
 * watcher UI / dashboard all import from here so a status renamed in one
 * place updates the whole app.
 */

/** Recoverable errors — pipeline can re-run from the failing step. */
export const RETRYABLE_ERROR_STATUSES = new Set<string>([
  "retryable_error",
  "error",
])

/** Terminal — needs human intervention before a re-run can succeed. */
export const TERMINAL_ERROR_STATUSES = new Set<string>([
  "terminal_error",
  "cf_pool_full",
  "content_blocked",
  "purchase_failed",
])

/**
 * Pipeline paused, awaiting an external event (DNS propagation, manual NS
 * change at registrar, registrant info). Distinct badge color in the UI:
 * "I need to act."
 */
export const WAITING_STATUSES = new Set<string>([
  "manual_action_required",
  "waiting_dns",
  "ns_pending_external",
])

/**
 * A step finished and the pipeline is positioned to start the next phase.
 * Useful as both pipeline-set states and operator-set overrides.
 */
export const READY_STATUSES = new Set<string>([
  "ready_for_ssl",
  "ready_for_content",
  "zone_active",
  "ssl_installed",
])

/** Statuses where the live-checker is allowed to flip live ↔ hosted. */
export const LIVE_CANDIDATE_STATUSES = new Set<string>([
  "hosted",
  "live",
])

/** Statuses that count as "currently the site is up." */
export const SUCCESS_STATUSES = new Set<string>([
  "hosted",
  "live",
  "ssl_installed",
])

export function isRetryableError(status: string | null | undefined): boolean {
  return !!status && RETRYABLE_ERROR_STATUSES.has(status)
}

export function isTerminalError(status: string | null | undefined): boolean {
  return !!status && TERMINAL_ERROR_STATUSES.has(status)
}

export function isErrorStatus(status: string | null | undefined): boolean {
  return isRetryableError(status) || isTerminalError(status)
}

export function isWaitingStatus(status: string | null | undefined): boolean {
  return !!status && WAITING_STATUSES.has(status)
}

export function isReadyStatus(status: string | null | undefined): boolean {
  return !!status && READY_STATUSES.has(status)
}

export function isSuccessStatus(status: string | null | undefined): boolean {
  return !!status && SUCCESS_STATUSES.has(status)
}

/** The 10 pipeline steps + their human-readable names. Single source. */
export const PIPELINE_STEPS: Readonly<Record<number, string>> = Object.freeze({
  1: "Buy / Detect Domain",
  2: "Assign Cloudflare Key",
  3: "Create Zone in Cloudflare",
  4: "Set Nameservers",
  5: "Wait for Zone Active",
  6: "Pick / Provision Server",
  7: "Create Site on ServerAvatar",
  8: "Issue & Install Origin SSL",
  9: "Generate Site Content (LLM)",
  10: "Upload index.php",
})
