/**
 * Job handler: emergency tear-down of every server with no domain references.
 * Mirrors Flask api_destroy_all_servers's background worker. Each server:
 *   1. Skip if any domain still has server_id pointing at it.
 *   2. DELETE the DO droplet (stops billing).
 *   3. DELETE the SA server row from ServerAvatar.
 *   4. DELETE the local servers row.
 */
import { all, run } from "../db"
import { deleteDroplet } from "../digitalocean"
import { getSetting } from "../repos/settings"
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
    // 2. SA server
    const saId = s.sa_server_id
    const saOrg = s.sa_org_id || getSetting("serveravatar_org_id") || ""
    const saTok = getSetting("serveravatar_api_key") || ""
    if (saId && saOrg && saTok) {
      try {
        await fetch(
          `https://api.serveravatar.com/organizations/${saOrg}/servers/${saId}`,
          {
            method: "DELETE",
            headers: { Authorization: saTok, Accept: "application/json" },
            signal: AbortSignal.timeout(30_000),
          },
        )
      } catch { /* best-effort */ }
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
