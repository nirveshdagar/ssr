import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM domains")
  run("DELETE FROM servers")
  run("DELETE FROM settings")
  run("DELETE FROM pipeline_log")
  run("DELETE FROM sqlite_sequence WHERE name IN ('domains', 'servers')")
  vi.restoreAllMocks()
})

afterEach(() => { vi.restoreAllMocks() })

interface FakeCall { method: string; url: string; body?: string }

function installFetchMock(handlers: { match: RegExp | string; method?: string; respond: () => Response }[]) {
  const calls: FakeCall[] = []
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args
    const url = typeof input === "string" ? input : (input as Request | URL).toString()
    const method = (init?.method || "GET").toUpperCase()
    const body = typeof init?.body === "string" ? init.body : undefined
    calls.push({ method, url, body })
    for (const h of handlers) {
      const matched = typeof h.match === "string" ? url.includes(h.match) : h.match.test(url)
      const methodOk = !h.method || h.method.toUpperCase() === method
      if (matched && methodOk) return h.respond()
    }
    throw new Error(`no handler for ${method} ${url}`)
  })
  return calls
}

describe("boot — grey-cloud recovery", () => {
  it("re-enables proxy on grey-clouded A records for live/hosted domains", async () => {
    const { run } = await import("@/lib/db")
    run(
      `INSERT INTO domains(domain, status, cf_email, cf_global_key, cf_zone_id)
       VALUES('grey1.example.com', 'live', 'a@x.com', 'k', 'ZONE-1'),
             ('grey2.example.com', 'hosted', 'a@x.com', 'k', 'ZONE-2'),
             ('skipped.example.com', 'pending', 'a@x.com', 'k', 'ZONE-3')`,
    )

    let patchCount = 0
    installFetchMock([
      // List records — return one grey-clouded A record per zone
      {
        match: /\/dns_records\?type=A$/, method: "GET",
        respond: () => new Response(JSON.stringify({
          result: [
            { id: "rec-1", type: "A", name: "x", content: "1.2.3.4", proxied: false },
            { id: "rec-2", type: "A", name: "x", content: "1.2.3.4", proxied: true }, // already orange — should NOT be patched
          ],
        }), { status: 200 }),
      },
      // PATCH to re-enable proxy
      {
        match: /\/dns_records\/rec-1$/, method: "PATCH",
        respond: () => { patchCount++; return new Response(JSON.stringify({ success: true }), { status: 200 }) },
      },
    ])

    const { _internal } = await import("@/lib/boot")
    await _internal.recoverGreyCloudOnce()
    // 2 qualifying domains × 1 grey record each = 2 PATCHes
    expect(patchCount).toBe(2)

    // pipeline_log should record the restoration
    const { all } = await import("@/lib/db")
    const logs = all<{ status: string; message: string }>(
      "SELECT status, message FROM pipeline_log WHERE step = 'grey_cloud_recovery'",
    )
    expect(logs.some((l) => l.message.includes("Re-enabled proxy"))).toBe(true)
  })

  it("skips domains in non-live/hosted statuses", async () => {
    const { run } = await import("@/lib/db")
    run(
      `INSERT INTO domains(domain, status, cf_email, cf_global_key, cf_zone_id)
       VALUES('canceled.example.com', 'canceled', 'a@x.com', 'k', 'Z')`,
    )
    let listCount = 0
    installFetchMock([
      {
        match: /\/dns_records/, method: "GET",
        respond: () => { listCount++; return new Response(JSON.stringify({ result: [] }), { status: 200 }) },
      },
    ])
    const { _internal } = await import("@/lib/boot")
    await _internal.recoverGreyCloudOnce()
    expect(listCount).toBe(0)
  })
})

describe("boot — orphan droplet sweep", () => {
  it("logs a warning + notify when DO has droplets that aren't in the servers table", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    const { run } = await import("@/lib/db")
    setSetting("do_api_token", "ok")
    setSetting("notifications_enabled", "0")  // Suppresses real channel sends
    // Server with do_droplet_id=100 → known
    run(`INSERT INTO servers(name, ip, do_droplet_id) VALUES('known', '1.2.3.4', '100')`)

    installFetchMock([
      {
        match: /\/droplets/, method: "GET",
        respond: () => new Response(JSON.stringify({
          droplets: [
            { id: 100, name: "known", networks: { v4: [{ type: "public", ip_address: "1.2.3.4" }] } },
            { id: 999, name: "orphan", networks: { v4: [{ type: "public", ip_address: "5.5.5.5" }] } },
          ],
          links: { pages: {} },
        }), { status: 200 }),
      },
    ])

    const { _internal } = await import("@/lib/boot")
    await _internal.orphanDropletSweepOnce()

    const { all } = await import("@/lib/db")
    const logs = all<{ status: string; message: string }>(
      "SELECT status, message FROM pipeline_log WHERE step = 'orphan_droplets'",
    )
    expect(logs.length).toBeGreaterThan(0)
    expect(logs[0].message).toMatch(/orphan/i)
    expect(logs[0].message).toContain("999")
  })
})
