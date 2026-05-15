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
import { getSetting } from "../repos/settings"

interface ServerCreatePayload {
  name: string
  region?: string
  size?: string
}

export async function serverCreateHandler(payload: Record<string, unknown>): Promise<void> {
  const p = payload as unknown as ServerCreatePayload
  const name = p.name
  // Fallback chain: payload → settings (do_default_region/size) → legacy
  // hardcode. Defensive in case any caller enqueues a job without
  // explicit region/size (e.g. an internal handler that pre-dates the
  // settings field).
  const region = p.region || (getSetting("do_default_region") || "").trim() || "nyc1"
  const size = p.size || (getSetting("do_default_size") || "").trim() || "s-1vcpu-1gb"
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
      // Operator policy (set 2026-05-01): on a freshly-provisioned droplet,
      // if Layer 1's 2-attempt SA install fails, destroy the droplet
      // instantly instead of leaving it half-broken. The Flask-era behavior
      // ("mark ready anyway, operator can wire SA manually") wasted money
      // on a useless droplet that the operator usually never went back to
      // wire up. Destroy + clear DB row so the operator sees a clean
      // failure and can re-trigger provision (auto or manual).
      const saReason = (e as Error).message.slice(0, 200)
      const { isSaFastFailError, destroyServerNow } = await import("../auto-heal")
      const fastFailReason = isSaFastFailError(saReason)
      logPipeline(name, "server_create", "warning",
        `SA agent install ${fastFailReason ? "fast-failed" : "failed after 2 attempts"} on fresh droplet ` +
        `${dropletId} (${ip}) — destroying droplet to stop billing. Reason: ${saReason}`)
      await destroyServerNow({
        serverId,
        name,
        ip,
        doDropletId: String(dropletId),
        saServerId: null,
        reason: fastFailReason
          ? `SA fast-fail (server-create): ${fastFailReason}`
          : `Layer 1 exhausted (2 attempts) on fresh droplet via server.create`,
        auditDetail: `trigger=server_create_sa_fail droplet=${dropletId} ip=${ip} sa_reason=${saReason.slice(0, 80)}`,
        notifyTitle: `Fresh-build server #${serverId} auto-destroyed (SA install failed)`,
        notifyBody:
          `Operator-initiated server.create for ${name}: provisioned droplet at ${ip} but SA agent ` +
          `install ${fastFailReason ? "fast-failed" : "failed after 2 attempts"}. Per fresh-provision ` +
          `policy, droplet was DESTROYED to stop billing instead of left half-broken. ` +
          `Re-trigger provision from /servers if you need a new server.\n\nFailure detail: ${saReason}`,
      }).catch((destroyErr) => {
        logPipeline(name, "server_create", "failed",
          `Auto-destroy of fresh droplet ${dropletId} threw: ${(destroyErr as Error).message.slice(0, 200)}. ` +
          `MANUAL CLEANUP NEEDED: destroy droplet ${dropletId} (${ip}) from DO console.`)
      })
      return
    }
    updateServer(serverId, { sa_server_id: saServerId, status: "ready" })
    logPipeline(name, "server_create", "completed",
      `Server READY: ${ip} (SA: ${saServerId})`)
  } catch (e) {
    logPipeline(name, "server_create", "failed", (e as Error).message)
  }
}
