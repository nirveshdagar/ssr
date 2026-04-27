import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  // Order matters: drop domains FIRST (FK to cf_keys), then cf_keys, then
  // reset the AUTOINCREMENT sequence so each test gets predictable IDs.
  run("DELETE FROM domains")
  run("DELETE FROM cf_keys")
  run("DELETE FROM settings")
  run("DELETE FROM sqlite_sequence WHERE name IN ('cf_keys', 'domains')")
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

interface FakeFetchCall {
  method: string
  url: string
  body?: string
}

/** Install a fetch mock that responds based on URL patterns. Records every
 * call for assertions. */
function installFetchMock(handlers: { match: RegExp | string; method?: string; respond: () => Response }[]) {
  const calls: FakeFetchCall[] = []
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
    throw new Error(`no fetch handler for ${method} ${url}`)
  })
  return calls
}

describe("cloudflare zone create — self-heal on stale account_id", () => {
  it("retries with refreshed account_id when first POST gets CF error 1013", async () => {
    const { run } = await import("@/lib/db")
    // Seed a domain row with credentials + a cf_key_id so refreshCfAccountId can be called
    run(
      `INSERT INTO cf_keys(email, api_key, alias, cf_account_id, max_domains)
       VALUES('a@x.com', 'k1', null, 'OLD-ACCOUNT-ID', 20)`,
    )
    run(
      `INSERT INTO domains(domain, cf_email, cf_global_key, cf_account_id, cf_key_id)
       VALUES('zonetest.example.com', 'a@x.com', 'k1', 'OLD-ACCOUNT-ID', 1)`,
    )

    let postCount = 0
    const calls = installFetchMock([
      // First /zones POST — return CF error 1013 (invalid account)
      // Second /zones POST — return success
      {
        match: /\/zones$/, method: "POST",
        respond: () => {
          postCount++
          if (postCount === 1) {
            return new Response(
              JSON.stringify({
                success: false,
                errors: [{ code: 1013, message: "Account is not a valid account" }],
              }),
              { status: 403 },
            )
          }
          return new Response(
            JSON.stringify({
              success: true,
              result: {
                id: "ZONEID12345",
                name: "zonetest.example.com",
                status: "pending",
                name_servers: ["ns1.cf.com", "ns2.cf.com"],
              },
            }),
            { status: 200 },
          )
        },
      },
      // /accounts refresh
      {
        match: "/accounts", method: "GET",
        respond: () => new Response(
          JSON.stringify({ result: [{ id: "FRESH-ACCOUNT-ID" }] }),
          { status: 200 },
        ),
      },
    ])

    const { createZoneForDomain } = await import("@/lib/cloudflare")
    const result = await createZoneForDomain("zonetest.example.com")
    expect(result.zone_id).toBe("ZONEID12345")
    expect(result.nameservers).toEqual(["ns1.cf.com", "ns2.cf.com"])
    // First /zones POST failed → /accounts refresh → second /zones POST succeeded
    expect(postCount).toBe(2)
    expect(calls.some((c) => c.method === "GET" && c.url.includes("/accounts"))).toBe(true)
  })

  it("falls back to existing-zone GET when CF returns 'already exists' (1061)", async () => {
    const { run } = await import("@/lib/db")
    run(
      `INSERT INTO cf_keys(email, api_key, cf_account_id, max_domains)
       VALUES('b@x.com', 'k2', 'ACCT-B', 20)`,
    )
    run(
      `INSERT INTO domains(domain, cf_email, cf_global_key, cf_account_id, cf_key_id)
       VALUES('exists.example.com', 'b@x.com', 'k2', 'ACCT-B', 1)`,
    )
    installFetchMock([
      {
        match: /\/zones$/, method: "POST",
        respond: () => new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 1061, message: "An identical record already exists" }],
          }),
          { status: 400 },
        ),
      },
      {
        match: /\/zones\?name=/, method: "GET",
        respond: () => new Response(
          JSON.stringify({
            success: true,
            result: [{
              id: "EXISTING-ZONE",
              name: "exists.example.com",
              status: "active",
              name_servers: ["ns1.cf.com", "ns2.cf.com"],
            }],
          }),
          { status: 200 },
        ),
      },
    ])
    const { createZoneForDomain } = await import("@/lib/cloudflare")
    const result = await createZoneForDomain("exists.example.com")
    expect(result.zone_id).toBe("EXISTING-ZONE")
    expect(result.status).toBe("active")
  })
})
