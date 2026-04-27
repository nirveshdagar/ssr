/**
 * Next.js instrumentation hook — runs once per server runtime, before any
 * request handlers. Used here to register job handlers + boot the
 * in-process worker pool.
 *
 * https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { registerHandler, startPool } = await import("./lib/jobs")
  const { cfBulkSetIp, cfBulkSetSettings, cfBulkDnsCsv } = await import("./lib/handlers/cf-bulk")
  try { registerHandler("cf.bulk_set_ip",       cfBulkSetIp) } catch {}
  try { registerHandler("cf.bulk_set_settings", cfBulkSetSettings) } catch {}
  try { registerHandler("cf.bulk_dns_csv",      cfBulkDnsCsv) } catch {}
  const { registerPipelineHandlers } = await import("./lib/pipeline")
  try { registerPipelineHandlers() } catch {}
  const { certBackfillHandler } = await import("./lib/handlers/cert-backfill")
  try { registerHandler("cert.backfill", certBackfillHandler) } catch {}
  const { destroyAllHandler } = await import("./lib/handlers/destroy-all")
  try { registerHandler("server.destroy_all", destroyAllHandler) } catch {}
  const { domainTeardownHandler, domainBulkTeardownHandler } = await import("./lib/handlers/teardown")
  try { registerHandler("domain.teardown", domainTeardownHandler) } catch {}
  try { registerHandler("domain.bulk_teardown", domainBulkTeardownHandler) } catch {}
  const { serverCreateHandler } = await import("./lib/handlers/server-create")
  try { registerHandler("server.create", serverCreateHandler) } catch {}
  const { migrateNowHandler } = await import("./lib/handlers/migrate-now")
  try { registerHandler("server.migrate_now", migrateNowHandler) } catch {}
  startPool()
  // Boot resilience: grey-cloud recovery + orphan-droplet sweep.
  // Skip in test mode (vitest sets NODE_ENV=test).
  if (process.env.NODE_ENV !== "test") {
    const { scheduleBootHooks } = await import("./lib/boot")
    scheduleBootHooks()
  }
}
