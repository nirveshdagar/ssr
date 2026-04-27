import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM settings")
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

interface FakeCall {
  method: string
  url: string
  authHeader: string | null
}

function installFetchMock(handlers: { match: RegExp | string; method?: string; respond: () => Response }[]) {
  const calls: FakeCall[] = []
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    const [input, init] = args
    const url = typeof input === "string" ? input : (input as Request | URL).toString()
    const method = (init?.method || "GET").toUpperCase()
    const headers = init?.headers as Record<string, string> | undefined
    const auth = headers?.["Authorization"] ?? headers?.["authorization"] ?? null
    calls.push({ method, url, authHeader: auth })
    for (const h of handlers) {
      const matched = typeof h.match === "string" ? url.includes(h.match) : h.match.test(url)
      const methodOk = !h.method || h.method.toUpperCase() === method
      if (matched && methodOk) return h.respond()
    }
    throw new Error(`no handler for ${method} ${url}`)
  })
  return calls
}

describe("serveravatar — REST credential gating", () => {
  it("listServers throws when api key not configured", async () => {
    const { listServers } = await import("@/lib/serveravatar")
    await expect(listServers()).rejects.toThrow(/API key not configured/i)
  })

  it("listServers throws when org id not configured", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("serveravatar_api_key", "tok")
    const { listServers } = await import("@/lib/serveravatar")
    await expect(listServers()).rejects.toThrow(/Organization ID not configured/i)
  })

  it("listServers passes the raw token (NOT 'Bearer …') as Authorization", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("serveravatar_api_key", "raw-sa-token")
    setSetting("serveravatar_org_id", "org-1")
    const calls = installFetchMock([
      { match: "/servers", method: "GET", respond: () => new Response(JSON.stringify({ servers: [] }), { status: 200 }) },
    ])
    const { listServers } = await import("@/lib/serveravatar")
    await listServers()
    expect(calls[0].authHeader).toBe("raw-sa-token")
    expect(calls[0].authHeader).not.toMatch(/^Bearer/)
  })

  it("isSaServerAlive returns true on 200, false on 404", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("serveravatar_api_key", "tok")
    setSetting("serveravatar_org_id", "org-1")

    let respond404 = false
    installFetchMock([
      {
        match: /\/servers\/\d+/, method: "GET",
        respond: () => respond404
          ? new Response("not found", { status: 404 })
          : new Response(JSON.stringify({ server: { id: 42 } }), { status: 200 }),
      },
    ])
    const { isSaServerAlive } = await import("@/lib/serveravatar")
    expect(await isSaServerAlive("42")).toBe(true)
    respond404 = true
    expect(await isSaServerAlive("42")).toBe(false)
  })

  it("listApplications paginates until last_page reached", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("serveravatar_api_key", "tok")
    setSetting("serveravatar_org_id", "org-1")
    let page = 0
    installFetchMock([
      {
        match: "/applications", method: "GET",
        respond: () => {
          page++
          return new Response(JSON.stringify({
            applications: {
              current_page: page,
              data: [{ id: page * 10, name: `app-${page}` }],
              last_page: 3,
            },
          }), { status: 200 })
        },
      },
    ])
    const { listApplications } = await import("@/lib/serveravatar")
    const apps = await listApplications("server-id")
    expect(apps.length).toBe(3)
    expect(page).toBe(3)
    expect(apps.map((a) => a.name)).toEqual(["app-1", "app-2", "app-3"])
  })

  it("findAppId matches by primary_domain, exact name, or substring", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("serveravatar_api_key", "tok")
    setSetting("serveravatar_org_id", "org-1")
    installFetchMock([
      {
        match: "/applications", method: "GET",
        respond: () => new Response(JSON.stringify({
          applications: {
            current_page: 1, last_page: 1, data: [
              { id: 100, name: "foo-com", primary_domain: "foo.com" },
              { id: 200, name: "bar-net", primary_domain: "" },
              { id: 300, name: "matching-name", primary_domain: "" },
            ],
          },
        }), { status: 200 }),
      },
    ])
    const { findAppId } = await import("@/lib/serveravatar")
    expect(await findAppId("server-id", "foo.com")).toBe("100")
    expect(await findAppId("server-id", "matching-name")).toBe("300")
    expect(await findAppId("server-id", "nope.example.com")).toBeNull()
  })
})
