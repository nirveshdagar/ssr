import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM settings")
  run("DELETE FROM servers")
  run("DELETE FROM sqlite_sequence WHERE name IN ('servers')")
  delete (globalThis as Record<string, unknown>).__ssrDropletCreations
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

interface FakeCall {
  method: string
  url: string
  authHeader: string | null
  body?: string
}

function installFetchMock(handlers: { match: RegExp | string; method?: string; respond: (call: FakeCall) => Response }[]) {
  const calls: FakeCall[] = []
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args
    const url = typeof input === "string" ? input : (input as Request | URL).toString()
    const method = (init?.method || "GET").toUpperCase()
    const body = typeof init?.body === "string" ? init.body : undefined
    const headers = init?.headers as Record<string, string> | undefined
    const auth = headers?.["Authorization"] ?? headers?.["authorization"] ?? null
    const call: FakeCall = { method, url, authHeader: auth, body }
    calls.push(call)
    for (const h of handlers) {
      const matched = typeof h.match === "string" ? url.includes(h.match) : h.match.test(url)
      const methodOk = !h.method || h.method.toUpperCase() === method
      if (matched && methodOk) return h.respond(call)
    }
    throw new Error(`no fetch handler for ${method} ${url}`)
  })
  return calls
}

describe("digitalocean — DOAllTokensFailed", () => {
  it("primary 401 + backup 401 → DOAllTokensFailed with both attempts", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("do_api_token", "primary-bad")
    setSetting("do_api_token_backup", "backup-bad")

    const calls = installFetchMock([
      { match: /\/droplets/, respond: () => new Response("unauthorized", { status: 401 }) },
    ])
    const { listDroplets, DOAllTokensFailed } = await import("@/lib/digitalocean")
    let caught: unknown
    try { await listDroplets() } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(DOAllTokensFailed)
    const ex = caught as InstanceType<typeof DOAllTokensFailed>
    expect(ex.attempts.length).toBe(2)
    expect(ex.attempts[0][0]).toBe("primary")
    expect(ex.attempts[1][0]).toBe("backup")
    // Both tokens were tried
    const auths = calls.map((c) => c.authHeader)
    expect(auths).toContain("Bearer primary-bad")
    expect(auths).toContain("Bearer backup-bad")
  })

  it("primary 401 → backup OK uses backup token (failover)", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("do_api_token", "primary-bad")
    setSetting("do_api_token_backup", "backup-good")

    let nthCall = 0
    installFetchMock([
      {
        match: /\/droplets/, respond: (call) => {
          nthCall++
          if (call.authHeader === "Bearer primary-bad") {
            return new Response("forbidden", { status: 403 })
          }
          return new Response(
            JSON.stringify({ droplets: [], links: { pages: {} } }),
            { status: 200 },
          )
        },
      },
    ])
    const { listDroplets } = await import("@/lib/digitalocean")
    const result = await listDroplets()
    expect(result).toEqual([])
    expect(nthCall).toBe(2)
    // Verify we cached the working token
    const { getSetting } = await import("@/lib/repos/settings")
    expect(getSetting("do_last_working_token")).toBe("backup")
  })

  it("do_use_backup_first reverses the candidate order", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("do_api_token", "primary-good")
    setSetting("do_api_token_backup", "backup-also-good")
    setSetting("do_use_backup_first", "1")

    const callOrder: string[] = []
    installFetchMock([
      {
        match: /\/droplets/, respond: (call) => {
          callOrder.push(call.authHeader ?? "")
          return new Response(JSON.stringify({ droplets: [] }), { status: 200 })
        },
      },
    ])
    const { listDroplets } = await import("@/lib/digitalocean")
    await listDroplets()
    expect(callOrder[0]).toBe("Bearer backup-also-good")
  })
})

describe("digitalocean — cost cap", () => {
  it("DropletRateLimited fires once 'max_droplets_per_hour' is reached", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("do_api_token", "ok")
    setSetting("max_droplets_per_hour", "2")
    setSetting("server_root_password", "pw123")

    // We don't need a full create flow — only the pre-flight check matters.
    // Simulate two prior creations within the rolling window.
    const { recentDropletCreations } = await import("@/lib/digitalocean")
    const arr = (globalThis as { __ssrDropletCreations?: number[] }).__ssrDropletCreations ?? []
    const now = Date.now() / 1000
    arr.push(now - 600, now - 300)  // both within the 1h window
    ;(globalThis as { __ssrDropletCreations?: number[] }).__ssrDropletCreations = arr

    expect(recentDropletCreations()).toEqual({ last_hour: 2, cap: 2 })

    // Now the next create should be rate-limited BEFORE any HTTP
    installFetchMock([
      // No handlers needed — we expect zero fetch calls
    ])
    const { createDroplet, DropletRateLimited } = await import("@/lib/digitalocean")
    let caught: unknown
    try {
      await createDroplet({ name: "should-be-rejected" })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(DropletRateLimited)
  })

  it("recentDropletCreations purges entries older than 1h", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("max_droplets_per_hour", "5")
    const arr: number[] = []
    const now = Date.now() / 1000
    arr.push(now - 4000)            // > 1h ago — should be purged
    arr.push(now - 100)             // recent — should count
    ;(globalThis as { __ssrDropletCreations?: number[] }).__ssrDropletCreations = arr

    const { recentDropletCreations } = await import("@/lib/digitalocean")
    const r = recentDropletCreations()
    expect(r.last_hour).toBe(1)
    expect(r.cap).toBe(5)
  })
})
