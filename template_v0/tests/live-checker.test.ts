import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

const getServerInfo = vi.fn()
const getDroplet = vi.fn()
vi.mock("@/lib/serveravatar", () => ({ getServerInfo }))
vi.mock("@/lib/digitalocean", () => ({ getDroplet }))

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(() => {
  getServerInfo.mockReset()
  getDroplet.mockReset()
  process.env.SSR_SA_RECONFIRM_MS = "1" // don't actually wait 4s in tests
})
afterEach(() => { delete process.env.SSR_SA_RECONFIRM_MS })

/**
 * Regression: a single flaky SA 'disconnected' (SA's cloud<->agent link
 * flaps) used to instantly mark a LIVE server dead → spurious new droplet
 * + domain migration. probeSaAgentDead must now re-confirm.
 */
describe("probeSaAgentDead — flap resistance", () => {
  it("does NOT declare dead when SA flaps back to connected (the bug)", async () => {
    getServerInfo
      .mockResolvedValueOnce({ agent_status: "disconnected" }) // transient
      .mockResolvedValueOnce({ agent_status: "connected" })     // recovered
    const { probeSaAgentDead } = await import("@/lib/live-checker")
    expect(await probeSaAgentDead("sa-1")).toBeNull()
  })

  it("declares dead only when BOTH polls agree it's down", async () => {
    getServerInfo
      .mockResolvedValueOnce({ agent_status: "disconnected" })
      .mockResolvedValueOnce({ agent_status: "offline" })
    const { probeSaAgentDead } = await import("@/lib/live-checker")
    const r = await probeSaAgentDead("sa-1")
    expect(r).toMatch(/re-confirmed/)
  })

  it("returns null on transient errors (timeout/5xx), never 'dead'", async () => {
    getServerInfo.mockRejectedValue(new Error("HTTP 503 upstream"))
    const { probeSaAgentDead } = await import("@/lib/live-checker")
    expect(await probeSaAgentDead("sa-1")).toBeNull()
  })

  it("a healthy agent on the first poll short-circuits to null", async () => {
    getServerInfo.mockResolvedValueOnce({ agent_status: "connected" })
    const { probeSaAgentDead } = await import("@/lib/live-checker")
    expect(await probeSaAgentDead("sa-1")).toBeNull()
    expect(getServerInfo).toHaveBeenCalledTimes(1) // no second poll needed
  })
})

/**
 * THE money-losing bug, fixed: the slow path (all sites failing HTTPS for
 * the full threshold) used to mark a server dead + migrate WITHOUT ever
 * checking whether the box itself was alive. A perfectly healthy droplet
 * whose sites were down (nginx crash / expired SSL / CF edge problem) got
 * torn down and double-provisioned. checkDeadServers must now REQUIRE a
 * positive DO-404/archive or SA-offline confirmation before migrating.
 */
describe("checkDeadServers — never migrate a server that is actually ALIVE", () => {
  beforeEach(async () => {
    const { run } = await import("@/lib/db")
    run("DELETE FROM servers")
    run("DELETE FROM settings")
  })

  async function seedReadyServer() {
    const { run, one } = await import("@/lib/db")
    run(
      "INSERT INTO servers (name, ip, status, do_droplet_id, sa_server_id) " +
      "VALUES ('alive-box', '10.0.0.9', 'ready', 'D1', 'SA1')",
    )
    return one<{ id: number }>("SELECT id FROM servers WHERE name='alive-box'")!.id
  }
  async function statusOf(id: number) {
    const { one } = await import("@/lib/db")
    return one<{ status: string }>("SELECT status FROM servers WHERE id=?", id)!.status
  }

  it("ALL sites down past threshold but DO+SA say ALIVE → server stays 'ready' (the bug)", async () => {
    const id = await seedReadyServer()
    getDroplet.mockResolvedValue({ status: "active" })       // not 404/archive
    getServerInfo.mockResolvedValue({ agent_status: "connected" }) // alive
    const { checkDeadServers } = await import("@/lib/live-checker")
    // downStreak 12 ≥ default threshold 10 → old code would have migrated.
    await checkDeadServers(new Map([[id, [
      { domain: "a.com", downStreak: 12 },
      { domain: "b.com", downStreak: 12 },
    ]]]))
    expect(await statusOf(id)).toBe("ready") // NOT 'dead' — alive, refused
  })

  it("ALL sites down AND DO returns 404 → server marked 'dead' (genuine death still works)", async () => {
    const id = await seedReadyServer()
    getDroplet.mockRejectedValue(new Error("HTTP 404 droplet not found"))
    const { checkDeadServers } = await import("@/lib/live-checker")
    await checkDeadServers(new Map([[id, [
      { domain: "a.com", downStreak: 12 },
    ]]]))
    expect(await statusOf(id)).toBe("dead")
  })

  it("ALL sites down AND SA re-confirms offline → server marked 'dead'", async () => {
    const id = await seedReadyServer()
    getDroplet.mockResolvedValue({ status: "active" }) // DO can't confirm
    getServerInfo
      .mockResolvedValueOnce({ agent_status: "offline" })
      .mockResolvedValueOnce({ agent_status: "offline" }) // both polls agree
    const { checkDeadServers } = await import("@/lib/live-checker")
    await checkDeadServers(new Map([[id, [
      { domain: "a.com", downStreak: 12 },
    ]]]))
    expect(await statusOf(id)).toBe("dead")
  })

  it("not down enough → skipped, no liveness probe even attempted", async () => {
    const id = await seedReadyServer()
    const { checkDeadServers } = await import("@/lib/live-checker")
    await checkDeadServers(new Map([[id, [
      { domain: "a.com", downStreak: 1 }, // below every gate
    ]]]))
    expect(await statusOf(id)).toBe("ready")
    expect(getDroplet).not.toHaveBeenCalled()
    expect(getServerInfo).not.toHaveBeenCalled()
  })
})
