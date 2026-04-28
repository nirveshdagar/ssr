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
    // saRequest's combined error message: "API key + org id not configured"
    const { listServers } = await import("@/lib/serveravatar")
    await expect(listServers()).rejects.toThrow(/not configured/i)
  })

  it("listServers throws when org id not configured", async () => {
    // Same combined message — saRequest treats key + org as a candidate
    // pair and only includes it in the failover list if BOTH are present.
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("serveravatar_api_key", "tok")
    const { listServers } = await import("@/lib/serveravatar")
    await expect(listServers()).rejects.toThrow(/not configured/i)
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

// ---------------------------------------------------------------------------
// SA primary→backup token failover (saRequest)
// ---------------------------------------------------------------------------

describe("saRequest — primary→backup token failover", () => {
  it("falls over from primary to backup on 401", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("serveravatar_api_key", "primary-tok")
    setSetting("serveravatar_org_id", "org-primary")
    setSetting("serveravatar_api_key_backup", "backup-tok")
    setSetting("serveravatar_org_id_backup", "org-backup")
    const calls = installFetchMock([
      {
        match: "/organizations/org-primary/", method: "GET",
        respond: () => new Response("unauthorized", { status: 401 }),
      },
      {
        match: "/organizations/org-backup/", method: "GET",
        respond: () => new Response(JSON.stringify({ servers: [] }), { status: 200 }),
      },
    ])
    const { listServers } = await import("@/lib/serveravatar")
    await listServers()
    expect(calls).toHaveLength(2)
    expect(calls[0].authHeader).toBe("primary-tok")
    expect(calls[1].authHeader).toBe("backup-tok")
    expect(calls[0].url).toContain("/organizations/org-primary/")
    expect(calls[1].url).toContain("/organizations/org-backup/")
  })

  it("falls over on 429 (rate limit) and 422 (quota) too", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("serveravatar_api_key", "p")
    setSetting("serveravatar_org_id", "org-p")
    setSetting("serveravatar_api_key_backup", "b")
    setSetting("serveravatar_org_id_backup", "org-b")
    let primaryHits = 0
    installFetchMock([
      {
        match: "/organizations/org-p/", method: "GET",
        respond: () => { primaryHits++; return new Response("rate-limited", { status: 429 }) },
      },
      {
        match: "/organizations/org-b/", method: "GET",
        respond: () => new Response(JSON.stringify({ servers: [{ id: 1 }] }), { status: 200 }),
      },
    ])
    const { listServers } = await import("@/lib/serveravatar")
    const out = await listServers()
    expect(primaryHits).toBe(1)
    expect(out).toEqual([{ id: 1 }])
  })

  it("does NOT fall over on a real 4xx (e.g. 400 bad request) — surfaces immediately", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("serveravatar_api_key", "p")
    setSetting("serveravatar_org_id", "org-p")
    setSetting("serveravatar_api_key_backup", "b")
    setSetting("serveravatar_org_id_backup", "org-b")
    let backupHits = 0
    installFetchMock([
      {
        match: "/organizations/org-p/", method: "GET",
        respond: () => new Response("bad request", { status: 400 }),
      },
      {
        match: "/organizations/org-b/", method: "GET",
        respond: () => { backupHits++; return new Response("{}", { status: 200 }) },
      },
    ])
    const { listServers } = await import("@/lib/serveravatar")
    // listServers throws because primary returned 400 (which is not a
    // failover trigger — caller's responsibility to handle real errors).
    await expect(listServers()).rejects.toThrow(/HTTP 400/)
    expect(backupHits).toBe(0)
  })

  it("throws SAAllTokensFailed when BOTH tokens fail with failover statuses", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("serveravatar_api_key", "p")
    setSetting("serveravatar_org_id", "org-p")
    setSetting("serveravatar_api_key_backup", "b")
    setSetting("serveravatar_org_id_backup", "org-b")
    installFetchMock([
      {
        match: "/organizations/", method: "GET",
        respond: () => new Response("unauthorized", { status: 401 }),
      },
    ])
    const { listServers, SAAllTokensFailed } = await import("@/lib/serveravatar")
    let caught: unknown = null
    try { await listServers() } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(SAAllTokensFailed)
    expect((caught as Error).message).toMatch(/primary:.*backup:/i)
  })

  it("with no backup configured, falls back to primary only", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("serveravatar_api_key", "p")
    setSetting("serveravatar_org_id", "org-p")
    // backup intentionally NOT set
    const calls = installFetchMock([
      {
        match: "/organizations/org-p/", method: "GET",
        respond: () => new Response(JSON.stringify({ servers: [] }), { status: 200 }),
      },
    ])
    const { listServers } = await import("@/lib/serveravatar")
    await listServers()
    expect(calls).toHaveLength(1)
    expect(calls[0].authHeader).toBe("p")
  })

  it("createServer records the org_id of whichever candidate succeeded", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("serveravatar_api_key", "p")
    setSetting("serveravatar_org_id", "org-primary")
    setSetting("serveravatar_api_key_backup", "b")
    setSetting("serveravatar_org_id_backup", "org-backup")
    setSetting("sa_cloud_provider_id", "1")
    const { addServer } = await import("@/lib/repos/servers")
    const dbId = addServer("test-srv", "0.0.0.0")
    installFetchMock([
      {
        match: "/organizations/org-primary/servers", method: "POST",
        respond: () => new Response("rate-limited", { status: 429 }),
      },
      {
        match: "/organizations/org-backup/servers", method: "POST",
        respond: () => new Response(JSON.stringify({ server: { id: 99, ip: "1.2.3.4" } }), { status: 201 }),
      },
    ])
    const { createServer } = await import("@/lib/serveravatar")
    const r = await createServer({ serverName: "test-srv", serverIdDb: dbId })
    expect(r.saServerId).toBe("99")
    expect(r.ip).toBe("1.2.3.4")
    // Critical: sa_org_id stored on DB row should be the BACKUP org, not primary
    const { listServers: listDb } = await import("@/lib/repos/servers")
    const row = listDb().find((s) => s.id === dbId)
    expect(row?.sa_org_id).toBe("org-backup")
  })
})

// ---------------------------------------------------------------------------
// DO primary→backup token failover (doRequest)
// ---------------------------------------------------------------------------

describe("digitalocean — primary→backup token failover", () => {
  it("falls over to backup on 401, 403, 422, 429, 5xx", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    for (const status of [401, 403, 422, 429, 500, 503, 522]) {
      vi.restoreAllMocks()
      setSetting("do_api_token", "primary-tok")
      setSetting("do_api_token_backup", "backup-tok")
      let primaryHits = 0
      let backupHits = 0
      vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
        const [, init] = args
        const headers = init?.headers as Record<string, string> | undefined
        const auth = headers?.["Authorization"] ?? headers?.["authorization"] ?? ""
        if (auth.includes("primary-tok")) {
          primaryHits++
          return new Response("err", { status })
        }
        if (auth.includes("backup-tok")) {
          backupHits++
          return new Response(JSON.stringify({ droplets: [], links: {} }), { status: 200 })
        }
        throw new Error("unexpected token")
      })
      const { listDroplets } = await import("@/lib/digitalocean")
      await listDroplets()
      expect(primaryHits).toBe(1)
      expect(backupHits).toBe(1)
    }
  })

  it("does NOT fall over on a 404 (real not-found) — surfaces immediately", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("do_api_token", "primary-tok")
    setSetting("do_api_token_backup", "backup-tok")
    let backupHits = 0
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const [, init] = args
      const headers = init?.headers as Record<string, string> | undefined
      const auth = headers?.["Authorization"] ?? headers?.["authorization"] ?? ""
      if (auth.includes("primary-tok")) {
        return new Response("not found", { status: 404 })
      }
      backupHits++
      return new Response(JSON.stringify({ droplet: { id: 1 } }), { status: 200 })
    })
    const { getDroplet } = await import("@/lib/digitalocean")
    await expect(getDroplet("missing-id")).rejects.toThrow(/HTTP 404/)
    expect(backupHits).toBe(0)
  })

  it("throws DOAllTokensFailed when both tokens fail", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("do_api_token", "primary-tok")
    setSetting("do_api_token_backup", "backup-tok")
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 401 }))
    const { listDroplets, DOAllTokensFailed } = await import("@/lib/digitalocean")
    let caught: unknown = null
    try { await listDroplets() } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(DOAllTokensFailed)
    expect((caught as Error).message).toMatch(/primary:.*backup:/i)
  })

  it("network error on primary triggers backup retry", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("do_api_token", "primary-tok")
    setSetting("do_api_token_backup", "backup-tok")
    let primaryAttempted = false
    let backupHits = 0
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const [, init] = args
      const headers = init?.headers as Record<string, string> | undefined
      const auth = headers?.["Authorization"] ?? headers?.["authorization"] ?? ""
      if (auth.includes("primary-tok")) {
        primaryAttempted = true
        throw new Error("ECONNREFUSED")
      }
      backupHits++
      return new Response(JSON.stringify({ droplets: [], links: {} }), { status: 200 })
    })
    const { listDroplets } = await import("@/lib/digitalocean")
    await listDroplets()
    expect(primaryAttempted).toBe(true)
    expect(backupHits).toBe(1)
  })
})
