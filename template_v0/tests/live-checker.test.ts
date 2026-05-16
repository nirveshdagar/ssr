import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const getServerInfo = vi.fn()
vi.mock("@/lib/serveravatar", () => ({ getServerInfo }))

beforeEach(() => {
  getServerInfo.mockReset()
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
