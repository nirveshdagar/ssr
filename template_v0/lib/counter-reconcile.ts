/**
 * Self-healing for denormalized counters.
 *
 * `cf_keys.domains_used` is a denormalized count only ever `+1`'d inside
 * assignCfKeyToDomain. Domains linked any other way (SA-import,
 * bulk-import, CF sync's link/backfill) never bumped it, so the CF-keys
 * page showed "0 domains" for keys that clearly had some — and the only
 * fix was running CF sync by hand. This recomputes it from the source of
 * truth on a low-frequency sweep so it self-corrects unattended.
 *
 * Deliberately scoped to cf_keys.domains_used only — its source of truth
 * is unambiguous (COUNT of domains.cf_key_id). servers.sites_count is NOT
 * touched: its semantics (our domain count vs ServerAvatar-reported) are
 * not assumed here.
 */
import { run } from "./db"
import { logPipeline } from "./repos/logs"

/** Set cf_keys.domains_used to the real count for any key where it's
 *  wrong. Non-destructive (writes the truth). Returns rows corrected. */
export function reconcileCfKeyCounters(): number {
  const r = run(
    `UPDATE cf_keys
        SET domains_used = (SELECT COUNT(*) FROM domains WHERE domains.cf_key_id = cf_keys.id)
      WHERE domains_used <> (SELECT COUNT(*) FROM domains WHERE domains.cf_key_id = cf_keys.id)`,
  )
  return Number((r as { changes?: number } | undefined)?.changes ?? 0)
}

/** Boot hook: reconcile shortly after start, then hourly. Self-skips in
 *  tests and when SSR_COUNTER_RECONCILE=0. HMR-safe singleton. */
export function startCounterReconcile(): void {
  if (process.env.NODE_ENV === "test" || process.env.SSR_COUNTER_RECONCILE === "0") return
  const g = globalThis as Record<string, unknown>
  if (g.__ssrCounterReconcile) return
  const everyMs = Number(process.env.SSR_COUNTER_RECONCILE_MS) || 3_600_000
  const tick = (): void => {
    try {
      const n = reconcileCfKeyCounters()
      if (n > 0) {
        logPipeline("(startup)", "counter_reconcile", "completed",
          `Self-healed cf_keys.domains_used on ${n} key(s)`)
      }
    } catch { /* best-effort — never wedge the server */ }
  }
  setTimeout(tick, 15_000).unref?.()
  const handle = setInterval(tick, everyMs)
  handle.unref?.()
  g.__ssrCounterReconcile = handle
}
