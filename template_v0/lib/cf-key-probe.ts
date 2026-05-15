/**
 * Shared HTTPS-probe logic for CF keys. Used by both the per-key
 * /api/cf-keys/[id]/refresh-status route and the scoped bulk variant
 * /api/cf-keys/bulk-refresh-status. Lives here so the two routes can't
 * drift in behavior (concurrency, decisive flip semantics, last_error
 * persistence).
 */

import { all, run } from "./db"
import { logPipeline } from "./repos/logs"
import { setCfKeyLastError } from "./repos/cf-keys"

export interface DomainProbeResult {
  domain: string
  before: string
  after: string
  http_status: number | null
  error: string | null
}

export interface KeyProbeSummary {
  key_id: number
  count: number
  flipped: number
  errored: number
  results: DomainProbeResult[]
}

const PROBE_TIMEOUT_MS = 8000
const PROBE_MAX_WORKERS = 20

/**
 * Probe every hosted/live domain under one CF key. Decisive: a single
 * 2xx/3xx flips `hosted` → `live` immediately. Probe failures leave status
 * alone (transient blips on the dashboard's network shouldn't downgrade —
 * the background streak-based live-checker handles sustained outages).
 *
 * Persists `last_error` on the cf_keys row when ALL probes fail
 * (every-domain failure is a strong signal of a key/pool-wide problem,
 * e.g. CF blocking the operator's IP). Clears `last_error` when at least
 * one probe succeeds.
 */
export async function probeKeyDomains(keyId: number): Promise<KeyProbeSummary> {
  const rows = all<{ domain: string; status: string }>(
    `SELECT domain, status FROM domains
      WHERE cf_key_id = ? AND status IN ('hosted','live')
      ORDER BY domain`,
    keyId,
  )
  if (rows.length === 0) {
    return { key_id: keyId, count: 0, flipped: 0, errored: 0, results: [] }
  }

  async function probeOne(d: { domain: string; status: string }): Promise<DomainProbeResult> {
    try {
      const res = await fetch(`https://${d.domain}/`, {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": "SSR-refresh-status/1.0" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      const ok = res.status >= 200 && res.status < 400
      const after = ok ? "live" : "hosted"
      if (after !== d.status) {
        run(
          `UPDATE domains SET status = ?, updated_at = datetime('now') WHERE domain = ?`,
          after, d.domain,
        )
        logPipeline(d.domain, "live_check", "completed",
          `Operator-initiated refresh: ${d.status} → ${after} (HTTP ${res.status})`)
      }
      return { domain: d.domain, before: d.status, after, http_status: res.status, error: null }
    } catch (e) {
      return {
        domain: d.domain, before: d.status, after: d.status,
        http_status: null, error: (e as Error).message.slice(0, 200),
      }
    }
  }

  const results = new Array<DomainProbeResult>(rows.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= rows.length) return
      results[i] = await probeOne(rows[i])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PROBE_MAX_WORKERS, rows.length) }, () => worker()),
  )

  const flipped = results.filter((r) => r.before !== r.after).length
  const errored = results.filter((r) => r.error !== null).length

  // Persist key-level health signal: if every probe failed, surface that
  // on the row so the operator's Issues column shows it without expanding.
  if (errored === results.length && results.length > 0) {
    setCfKeyLastError(keyId,
      `All ${results.length} probe(s) failed — sample: ${results[0]?.error ?? "?"}`)
  } else {
    setCfKeyLastError(keyId, null)
  }

  return { key_id: keyId, count: rows.length, flipped, errored, results }
}
