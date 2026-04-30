/**
 * Job handler: reinstall the SA agent on an existing DO droplet without
 * provisioning a new VM. Used to recover from cases where the agent
 * install failed mid-script (apt blip, network glitch, agent registration
 * never completed) — the droplet itself is fine, just needs the install
 * re-run cleanly.
 *
 * Flow:
 *   1. Look up the server row + IP + any half-registered SA stub
 *   2. If a SA stub exists, DELETE it from SA (so the new install doesn't
 *      collide on name/IP)
 *   3. Confirm the DO droplet is still alive (404/archive → bail with a
 *      clear error; this is "reinstall on existing droplet", not "create
 *      a new one")
 *   4. Run installAgentOnDroplet (which now has its own retry-with-cleanup)
 *   5. Update the servers row with new sa_server_id and status='ready'
 */
import { logPipeline } from "../repos/logs"
import { getServer, updateServer } from "../repos/servers"
import { appendAudit } from "../repos/audit"

interface ReinstallSaPayload {
  server_id: number
}

export async function reinstallSaHandler(payload: Record<string, unknown>): Promise<void> {
  const p = payload as unknown as ReinstallSaPayload
  const server = getServer(p.server_id)
  if (!server) {
    logPipeline(`server-${p.server_id}`, "reinstall_sa", "failed", "server row not found")
    return
  }
  if (!server.ip) {
    logPipeline(`server-${p.server_id}`, "reinstall_sa", "failed", "server has no IP")
    return
  }
  const serverName = server.name ?? `server-${p.server_id}`
  const dropletIp = server.ip

  // Step 1: confirm DO droplet is alive. If it's gone, this isn't a
  // reinstall scenario — the operator should provision a new server.
  if (server.do_droplet_id) {
    try {
      const { getDroplet } = await import("../digitalocean")
      const d = await getDroplet(server.do_droplet_id)
      if (d.status === "archive") {
        logPipeline(`server-${p.server_id}`, "reinstall_sa", "failed",
          `DO droplet ${server.do_droplet_id} is archived — provision a new server instead`)
        return
      }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes("HTTP 404")) {
        logPipeline(`server-${p.server_id}`, "reinstall_sa", "failed",
          `DO droplet ${server.do_droplet_id} returns 404 (deleted) — provision a new server instead`)
        return
      }
      logPipeline(`server-${p.server_id}`, "reinstall_sa", "warning",
        `DO probe failed: ${msg.slice(0, 160)} — proceeding anyway`)
    }
  }

  // Step 2: clean up any half-registered SA entry. Either we have a
  // sa_server_id from a previous attempt, or we look up by IP in case
  // the previous attempt registered but our DB never got the id.
  const { deleteSaServer, listServers: listSaServers } = await import("../serveravatar")
  let cleanedCount = 0
  if (server.sa_server_id) {
    const r = await deleteSaServer(server.sa_server_id)
    if (r.ok) cleanedCount++
    logPipeline(`server-${p.server_id}`, "reinstall_sa",
      r.ok ? "completed" : "warning",
      r.ok
        ? `Deleted stale SA stub ${server.sa_server_id}`
        : `SA stub delete failed: ${r.reason}`)
  }
  // Also catch the case where SA has an entry by IP that we don't know about.
  try {
    const all = await listSaServers()
    for (const s of all) {
      const sIp = String(s.server_ip ?? s.ip ?? "")
      const sId = String(s.id ?? "")
      if (sIp === dropletIp && sId && sId !== String(server.sa_server_id ?? "")) {
        logPipeline(`server-${p.server_id}`, "reinstall_sa", "running",
          `Found unowned SA entry ${sId} at our IP ${sIp} — deleting before reinstall`)
        const r = await deleteSaServer(sId)
        if (r.ok) cleanedCount++
      }
    }
  } catch (e) {
    logPipeline(`server-${p.server_id}`, "reinstall_sa", "warning",
      `SA listServers failed during pre-clean: ${(e as Error).message.slice(0, 160)}`)
  }

  // Step 3: run install. installAgentOnDroplet has its own retry-with-cleanup
  // for transient mid-install failures.
  updateServer(p.server_id, { sa_server_id: null, status: "creating" } as Parameters<typeof updateServer>[1])
  logPipeline(`server-${p.server_id}`, "reinstall_sa", "running",
    `Reinstalling SA agent on ${dropletIp} (${cleanedCount} stale SA entr${cleanedCount === 1 ? "y" : "ies"} cleaned)`)

  let saServerId: string
  try {
    const { installAgentOnDroplet } = await import("../serveravatar")
    saServerId = await installAgentOnDroplet({
      dropletIp,
      serverName,
      onProgress: (msg) => logPipeline(`server-${p.server_id}`, "reinstall_sa", "running", msg),
    })
  } catch (e) {
    const msg = (e as Error).message
    updateServer(p.server_id, { status: "error" } as Parameters<typeof updateServer>[1])
    logPipeline(`server-${p.server_id}`, "reinstall_sa", "failed",
      `Reinstall failed after retries: ${msg.slice(0, 400)}`)
    appendAudit("server_reinstall_sa_failed", `server-${p.server_id}`,
      `ip=${dropletIp} reason=${msg.slice(0, 200)}`, null)
    return
  }

  // Step 4: success — wire the row back up.
  updateServer(p.server_id, {
    sa_server_id: saServerId,
    status: "ready",
  } as Parameters<typeof updateServer>[1])
  logPipeline(`server-${p.server_id}`, "reinstall_sa", "completed",
    `Server #${p.server_id} ready: SA agent installed (sa_server_id=${saServerId})`)
  appendAudit("server_reinstall_sa", `server-${p.server_id}`,
    `ip=${dropletIp} sa_server_id=${saServerId}`, null)
}
