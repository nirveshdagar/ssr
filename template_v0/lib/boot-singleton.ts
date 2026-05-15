/**
 * Lazy boot of the job pool + sweepers. Replaces the work that used to live
 * in instrumentation.ts:register() — but called on first DB access instead
 * of at server-start time.
 *
 * Why: Next.js 16 builds `instrumentation.ts` for both Node AND Edge
 * runtimes. Even with `if (process.env.NEXT_RUNTIME !== "nodejs") return`
 * at the top, the bundler's static analysis traces every dynamic import
 * for both targets and chokes on patchright + ssh2 + node:fs in the Edge
 * build. Moving the heavy imports here, behind a getDb() call (which is
 * never reached from the Edge runtime — middleware.ts doesn't touch the
 * DB), sidesteps the whole Edge-trace problem.
 *
 * Trade-off: first /api/* request after server start pays a ~50 ms boot
 * tax (handler registration is synchronous; pool start is fire-and-forget).
 * Subsequent requests see no overhead — `started` short-circuits.
 */

let started = false

export function ensureStarted(): void {
  if (started) return
  started = true
  if (process.env.NODE_ENV === "test") return
  // Fire-and-forget — don't block the caller.
  void bootEverything().catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[boot] failed to initialize:", e)
    // Allow a retry on next call. Without this, a transient error here
    // (e.g. one handler module failed to load) would silently disable
    // the entire job pool until process restart.
    started = false
  })
}

async function bootEverything(): Promise<void> {
  const { registerHandler, startPool } = await import("./jobs")
  const safe = (label: string, fn: () => void) => {
    try { fn() } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[boot] failed to register ${label}:`, e)
    }
  }

  const { cfBulkSetIp, cfBulkSetSettings, cfBulkDnsCsv } = await import("./handlers/cf-bulk")
  safe("cf.bulk_set_ip",       () => registerHandler("cf.bulk_set_ip",       cfBulkSetIp))
  safe("cf.bulk_set_settings", () => registerHandler("cf.bulk_set_settings", cfBulkSetSettings))
  safe("cf.bulk_dns_csv",      () => registerHandler("cf.bulk_dns_csv",      cfBulkDnsCsv))

  const { registerPipelineHandlers } = await import("./pipeline")
  safe("pipeline.*", () => registerPipelineHandlers())

  const { certBackfillHandler } = await import("./handlers/cert-backfill")
  safe("cert.backfill", () => registerHandler("cert.backfill", certBackfillHandler))

  const { destroyAllHandler } = await import("./handlers/destroy-all")
  safe("server.destroy_all", () => registerHandler("server.destroy_all", destroyAllHandler))

  const { domainTeardownHandler, domainBulkTeardownHandler } = await import("./handlers/teardown")
  safe("domain.teardown",      () => registerHandler("domain.teardown", domainTeardownHandler))
  safe("domain.bulk_teardown", () => registerHandler("domain.bulk_teardown", domainBulkTeardownHandler))

  const { serverCreateHandler } = await import("./handlers/server-create")
  safe("server.create", () => registerHandler("server.create", serverCreateHandler))

  const { migrateNowHandler } = await import("./handlers/migrate-now")
  safe("server.migrate_now", () => registerHandler("server.migrate_now", migrateNowHandler))

  const { bulkMigrateHandler } = await import("./handlers/bulk-migrate")
  safe("domain.bulk_migrate", () => registerHandler("domain.bulk_migrate", bulkMigrateHandler))

  const { reinstallSaHandler } = await import("./handlers/reinstall-sa")
  safe("server.reinstall_sa", () => registerHandler("server.reinstall_sa", reinstallSaHandler))

  startPool()

  // Boot resilience: grey-cloud recovery + orphan-droplet sweep + auto-heal +
  // backup + retention. Skips itself in tests + when SSR_AUTOHEAL=0 etc.
  const { scheduleBootHooks } = await import("./boot")
  scheduleBootHooks()

  installProcessHandlers()
}

declare global {
  // eslint-disable-next-line no-var
  var __ssrProcessHandlersInstalled: boolean | undefined
}

function installProcessHandlers(): void {
  if (globalThis.__ssrProcessHandlersInstalled) return
  globalThis.__ssrProcessHandlersInstalled = true

  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    // eslint-disable-next-line no-console
    console.log(`[shutdown] received ${signal}; draining job pool (max 30s)`)
    void Promise.race([
      (async () => {
        try {
          const { stopPool } = await import("./jobs")
          await stopPool()
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[shutdown] stopPool error:", e)
        }
        try {
          const { stopAutoHeal } = await import("./auto-heal")
          stopAutoHeal()
        } catch { /* best-effort */ }
        try {
          const { stop: stopLiveChecker } = await import("./live-checker")
          await stopLiveChecker()
        } catch { /* live-checker may not be running */ }
      })(),
      new Promise((r) => setTimeout(r, 30_000)),
    ]).finally(() => {
      // Don't process.exit — let Node drain naturally.
    })
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("uncaughtException", (err) => {
    // eslint-disable-next-line no-console
    console.error("[uncaughtException]", err)
    process.nextTick(() => { throw err })
  })
  process.on("unhandledRejection", (reason) => {
    // eslint-disable-next-line no-console
    console.error("[unhandledRejection]", reason)
  })
}
