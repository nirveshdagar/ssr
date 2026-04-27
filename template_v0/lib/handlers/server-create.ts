/**
 * Job handler: provision a new DigitalOcean droplet, install the SA agent.
 * Mirrors Flask's _server_create_handler.
 *
 * Flow:
 *   1. createDroplet (DO POST + IPv4 poll + DB row insert)
 *   2. waitForSsh on the fresh droplet (cloud-init may still be running)
 *   3. Re-set the root password + ensure PasswordAuthentication is on
 *   4. Generate SA install command, run it via SSH
 *   5. Poll SA-side for agent_status=connected for up to 600s
 *   6. Mark the servers row 'ready' (or warn-and-mark-ready on timeout)
 *
 * The Node version's `installAgentOnDroplet` already encapsulates steps 4-5,
 * so we wire that directly. Step 3 is the SSH password reset — `createDroplet`
 * already plants the password via cloud-init, and `installAgentOnDroplet`
 * re-uses that, so an explicit chpasswd round-trip is only needed when the
 * operator overrides the cloud-init password mid-build (rare).
 */
import { logPipeline } from "../repos/logs"
import { updateServer } from "../repos/servers"

interface ServerCreatePayload {
  name: string
  region?: string
  size?: string
}

export async function serverCreateHandler(payload: Record<string, unknown>): Promise<void> {
  const p = payload as unknown as ServerCreatePayload
  const name = p.name
  const region = p.region || "nyc1"
  const size = p.size || "s-1vcpu-1gb"
  try {
    const { createDroplet } = await import("../digitalocean")
    const { installAgentOnDroplet } = await import("../serveravatar")

    const { serverId, ip, dropletId } = await createDroplet({ name, region, size })
    logPipeline(name, "server_create", "running",
      `Droplet ${dropletId} ready at ${ip} — installing SA agent (5-15 min)...`)

    let saServerId: string
    try {
      saServerId = await installAgentOnDroplet({ dropletIp: ip, serverName: name })
    } catch (e) {
      // Match Flask: warn-and-mark-ready on agent install timeout so the
      // dashboard still shows the server (operator can wire SA manually).
      updateServer(serverId, { status: "ready" })
      logPipeline(name, "server_create", "warning",
        `SA agent install timeout — marked ready anyway: ${(e as Error).message}`)
      return
    }
    updateServer(serverId, { sa_server_id: saServerId, status: "ready" })
    logPipeline(name, "server_create", "completed",
      `Server READY: ${ip} (SA: ${saServerId})`)
  } catch (e) {
    logPipeline(name, "server_create", "failed", (e as Error).message)
  }
}
