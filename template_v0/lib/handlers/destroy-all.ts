/**
 * Job handler: emergency tear-down of every server with no domain references.
 * Mirrors Flask api_destroy_all_servers's background worker. Each server:
 *   1. Skip if any domain still has server_id pointing at it.
 *   2. DELETE the DO droplet (stops billing).
 *   3. DELETE the SA server row from ServerAvatar.
 *   4. DELETE the local servers row.
 *
 * ALWAYS SEQUENTIAL — servers are torn down one at a time even though the
 * worker pool could fan out. Reasons:
 *   - DO and SA both rate-limit DELETE bursts; sequential keeps us under
 *     the bucket without needing extra throttle math.
 *   - If a token gets blocked mid-job, sequential failure is contained to
 *     one server while saRequest's primary→backup failover handles the
 *     transient case automatically.
 *   - Server destroy is rare and irreversible; predictable order makes the
 *     operator's audit log readable.
 */
import { all, run } from "../db"
import { deleteDroplet } from "../digitalocean"
import { logPipeline } from "../repos/logs"

interface ServerRow {
  id: number
  name: string | null
  ip: string | null
  do_droplet_id: string | null
  sa_server_id: string | null
  sa_org_id: string | null
}

export async function destroyAllHandler(_payload: Record<string, unknown>): Promise<void> {
  const servers = all<ServerRow>("SELECT * FROM servers")
  const skipped: string[] = []
  let destroyed = 0

  for (const s of servers) {
    const ref = (all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM domains WHERE server_id = ?", s.id,
    )[0]?.n) ?? 0
    if (ref > 0) {
      skipped.push(`${s.name || `srv-${s.id}`}(${ref} domains)`)
      continue
    }
    // 1. DO droplet
    if (s.do_droplet_id) {
      try {
        await deleteDroplet(s.do_droplet_id)
      } catch (e) {
        logPipeline(s.name || `srv-${s.id}`, "server_teardown", "warning",
          `DO delete: ${(e as Error).message}`)
      }
    }
    // 2. SA server — through saRequest so primary→backup token failover
    //    kicks in if the SA account is rate-limited / suspended.
    const saId = s.sa_server_id
    if (saId) {
      try {
        const { saRequest } = await import("../serveravatar")
        const { res } = await saRequest(`/organizations/{ORG_ID}/servers/${saId}`, {
          method: "DELETE", timeoutMs: 30_000,
        })
        if (!res.ok) {
          logPipeline(s.name || `srv-${s.id}`, "server_teardown", "warning",
            `SA delete: HTTP ${res.status}`)
        }
      } catch (e) {
        logPipeline(s.name || `srv-${s.id}`, "server_teardown", "warning",
          `SA delete: ${(e as Error).message}`)
      }
    }
    // 3. DB row
    run("DELETE FROM servers WHERE id = ?", s.id)
    destroyed++
    logPipeline(s.name || `srv-${s.id}`, "server_teardown", "completed",
      "Destroyed by emergency kill-switch")
  }

  logPipeline(
    "EMERGENCY", "destroy_all", "completed",
    `Destroyed ${destroyed} server(s). Skipped (still has domains): ${skipped.join(", ") || "none"}`,
  )
}
