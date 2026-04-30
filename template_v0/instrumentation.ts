/**
 * Next.js instrumentation hook — runs once per server runtime, before any
 * request handlers. We register job handlers + boot the in-process worker
 * pool here.
 *
 * Runtime: NODE ONLY. The body bails on Edge via the NEXT_RUNTIME check.
 *
 * Bundling: every dynamic import below is annotated with a turbopackIgnore
 * directive so Turbopack does not trace into the (Node-only) module graph
 * when it builds the Edge variant of this file. Without those annotations,
 * Turbopack pulls patchright + ssh2 + node:fs into the Edge build trace,
 * which fails with "module not found" / "non-ecmascript placeable asset"
 * errors.
 *
 * https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { registerHandler, startPool } = await import(/* turbopackIgnore: true */ "./lib/jobs")
  const { cfBulkSetIp, cfBulkSetSettings, cfBulkDnsCsv } = await import(/* turbopackIgnore: true */ "./lib/handlers/cf-bulk")
  // registerHandler is idempotent (Map.set), but each module-import is
  // wrapped in a try so a single failed handler module doesn't block the
  // rest. The import itself is what would throw — log loudly so a typo /
  // missing export doesn't make the corresponding job kind silently
  // unhandled.
  const safe = (label: string, fn: () => void) => {
    try { fn() } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[instrumentation] failed to register ${label}:`, e)
    }
  }
  safe("cf.bulk_set_ip",       () => registerHandler("cf.bulk_set_ip",       cfBulkSetIp))
  safe("cf.bulk_set_settings", () => registerHandler("cf.bulk_set_settings", cfBulkSetSettings))
  safe("cf.bulk_dns_csv",      () => registerHandler("cf.bulk_dns_csv",      cfBulkDnsCsv))
  const { registerPipelineHandlers } = await import(/* turbopackIgnore: true */ "./lib/pipeline")
  safe("pipeline.*", () => registerPipelineHandlers())
  const { certBackfillHandler } = await import(/* turbopackIgnore: true */ "./lib/handlers/cert-backfill")
  safe("cert.backfill", () => registerHandler("cert.backfill", certBackfillHandler))
  const { destroyAllHandler } = await import(/* turbopackIgnore: true */ "./lib/handlers/destroy-all")
  safe("server.destroy_all", () => registerHandler("server.destroy_all", destroyAllHandler))
  const { domainTeardownHandler, domainBulkTeardownHandler } = await import(/* turbopackIgnore: true */ "./lib/handlers/teardown")
  safe("domain.teardown", () => registerHandler("domain.teardown", domainTeardownHandler))
  safe("domain.bulk_teardown", () => registerHandler("domain.bulk_teardown", domainBulkTeardownHandler))
  const { serverCreateHandler } = await import(/* turbopackIgnore: true */ "./lib/handlers/server-create")
  safe("server.create", () => registerHandler("server.create", serverCreateHandler))
  const { migrateNowHandler } = await import(/* turbopackIgnore: true */ "./lib/handlers/migrate-now")
  safe("server.migrate_now", () => registerHandler("server.migrate_now", migrateNowHandler))
  const { bulkMigrateHandler } = await import(/* turbopackIgnore: true */ "./lib/handlers/bulk-migrate")
  safe("domain.bulk_migrate", () => registerHandler("domain.bulk_migrate", bulkMigrateHandler))
  startPool()
  // Boot resilience: grey-cloud recovery + orphan-droplet sweep.
  // Skip in test mode (vitest sets NODE_ENV=test).
  if (process.env.NODE_ENV !== "test") {
    const { scheduleBootHooks } = await import(/* turbopackIgnore: true */ "./lib/boot")
    scheduleBootHooks()
    installProcessHandlers()
  }
}

// HMR-safe: the Node process is shared across module re-eval, so we must not
// add a fresh listener every time `register()` runs in dev. Track on globalThis.
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
          const { stopPool } = await import(/* turbopackIgnore: true */ "./lib/jobs")
          await stopPool()
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[shutdown] stopPool error:", e)
        }
        try {
          const { stopAutoHeal } = await import(/* turbopackIgnore: true */ "./lib/auto-heal")
          stopAutoHeal()
        } catch { /* best-effort */ }
        try {
          const { stop: stopLiveChecker } = await import(/* turbopackIgnore: true */ "./lib/live-checker")
          await stopLiveChecker()
        } catch { /* live-checker may not be running */ }
      })(),
      new Promise((r) => setTimeout(r, 30_000)),
    ]).finally(() => {
      // Don't process.exit — let Node drain naturally now that workers are
      // stopped. If something is keeping the loop alive past the 30s grace,
      // the supervisor's SIGKILL will terminate.
    })
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))

  // uncaughtException / unhandledRejection: log loudly. Default Node
  // behavior is to terminate on uncaughtException — keep that. For
  // unhandledRejection we just record and let the default handler decide
  // (which on modern Node is also to terminate).
  process.on("uncaughtException", (err) => {
    // eslint-disable-next-line no-console
    console.error("[uncaughtException]", err)
    // Re-throw on next tick so Node's default abort/exit kicks in with
    // the same error info a vanilla crash would surface.
    process.nextTick(() => { throw err })
  })
  process.on("unhandledRejection", (reason) => {
    // eslint-disable-next-line no-console
    console.error("[unhandledRejection]", reason)
  })
}
