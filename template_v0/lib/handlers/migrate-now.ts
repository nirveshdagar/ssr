/**
 * Job handler: manual server migration. Wraps lib/migration.migrateServer
 * so the long-running work happens in the durable job pool, and uses the
 * live-checker's `migrating` set to dedupe against auto-detection.
 */
import { migrateServer } from "../migration"
import { releaseServerMigrating } from "../live-checker"
import { logPipeline } from "../repos/logs"
import { notifyMigrationDone } from "../notify"

interface Payload {
  server_id: number
  target_server_id?: number | null
}

export async function migrateNowHandler(payload: Record<string, unknown>): Promise<void> {
  const p = payload as unknown as Payload
  const serverId = p.server_id
  const targetId = p.target_server_id ?? null
  try {
    const result = await migrateServer(serverId, targetId)
    logPipeline(
      `server-${serverId}`, "migrate_server",
      result.failed.length === 0 ? "completed" : "warning",
      `${result.msg}  ok=${result.ok.length} failed=${result.failed.length}`,
    )
    try {
      await notifyMigrationDone(
        serverId, result.msg, result.ok.length, result.failed.length,
      )
    } catch { /* best-effort */ }
  } catch (e) {
    logPipeline(`server-${serverId}`, "migrate_server", "failed",
      `migrateServer raised: ${(e as Error).message}`)
  } finally {
    releaseServerMigrating(serverId)
  }
}
