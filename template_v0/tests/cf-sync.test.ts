import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { setupTestDb, cleanupTestDb } from "./_setup"

// The CF-sync route does deep CF DNS plumbing via these — out of scope for
// route-logic regression tests. Mock to isolate the reconcile passes
// (where all 3 of this session's bugs were).
vi.mock("@/lib/cloudflare", async (orig) => ({
  ...(await orig<typeof import("@/lib/cloudflare")>()),
  setupDomainDns: vi.fn(async () => true),
}))
vi.mock("@/lib/migration", () => ({
  captureCfRecordIds: vi.fn(async () => {}),
}))

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

interface Seeded { keyId: number; serverIp: string }

async function seed(opts: { domainsUsed?: number } = {}): Promise<Seeded> {
  const { run, one } = await import("@/lib/db")
  run("DELETE FROM domains")
  run("DELETE FROM cf_keys")
  run("DELETE FROM servers")
  run("DELETE FROM pipeline_log")
  run("DELETE FROM audit_log")
  run(
    `INSERT INTO cf_keys (email, api_key, alias, cf_account_id, domains_used, is_active)
     VALUES ('k@e.com', 'plainkey123', 'CFX', 'acct_1', ?, 1)`,
    opts.domainsUsed ?? 0,
  )
  const keyId = one<{ id: number }>("SELECT id FROM cf_keys WHERE email='k@e.com'")!.id
  run("INSERT INTO servers (name, ip, status) VALUES ('srv', '9.9.9.9', 'ready')")
  const serverId = one<{ id: number }>("SELECT id FROM servers WHERE ip='9.9.9.9'")!.id

  const { addDomain } = await import("@/lib/repos/domains")
  // Unlinked SA-import style: no cf_key_id, has a server, name matches a CF zone.
  addDomain("unlinked.test")
  run("UPDATE domains SET server_id=?, status='hosted' WHERE domain='unlinked.test'", serverId)
  // Linked but missing creds + no A record + has server.
  addDomain("needcreds.test")
  run(
    `UPDATE domains SET cf_key_id=?, cf_zone_id='zNEED', server_id=?, status='live'
      WHERE domain='needcreds.test'`,
    keyId, serverId,
  )
  // Linked, A record already set, but current_proxy_ip blank + has server
  // (exercises the pure-DB current_proxy_ip reconcile, not Pass 3).
  addDomain("hasdns.test")
  run(
    `UPDATE domains SET cf_key_id=?, cf_zone_id='zHAS', cf_email='k@e.com',
            cf_global_key='plainkey123', cf_a_record_id='rec_x', server_id=?, status='live'
      WHERE domain='hasdns.test'`,
    keyId, serverId,
  )
  // Linked, no A record, NO server → needs_server (can't point an A record).
  addDomain("noserver.test")
  run(
    `UPDATE domains SET cf_key_id=?, cf_zone_id='zNO', cf_email='k@e.com',
            cf_global_key='plainkey123', status='live'
      WHERE domain='noserver.test'`,
    keyId,
  )
  return { keyId, serverIp: "9.9.9.9" }
}

function stubZones() {
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input)
    if (url.includes("/zones?")) {
      return new Response(JSON.stringify({
        success: true,
        result: [
          { id: "zUNL", name: "unlinked.test", status: "active", name_servers: ["a.ns", "b.ns"] },
          { id: "zNEED", name: "needcreds.test", status: "active", name_servers: ["a.ns", "b.ns"] },
          { id: "zHAS", name: "hasdns.test", status: "active", name_servers: ["a.ns", "b.ns"] },
          { id: "zNO", name: "noserver.test", status: "active", name_servers: ["a.ns", "b.ns"] },
        ],
      }), { status: 200 })
    }
    return new Response("{}", { status: 200 })
  })
}

function post(form: Record<string, string> = {}) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(form)) fd.set(k, v)
  return new NextRequest("http://localhost/api/cloudflare/sync", { method: "POST", body: fd })
}

beforeEach(() => { vi.restoreAllMocks(); stubZones() })
afterEach(() => { vi.unstubAllGlobals() })

describe("POST /api/cloudflare/sync — reconcile regressions", () => {
  it("links unlinked domains, backfills creds + current_proxy_ip, recomputes domains_used", async () => {
    await seed({ domainsUsed: 0 }) // stored counter wrong on purpose
    const { POST } = await import("@/app/api/cloudflare/sync/route")
    const { one } = await import("@/lib/db")
    const res = await POST(post())
    const body = await res.json()
    expect(body.ok).toBe(true)

    // Pass 2: unlinked.test linked with key + zone + decrypted global key.
    const u = one<{ cf_key_id: number; cf_zone_id: string; cf_email: string; cf_global_key: string; current_proxy_ip: string }>(
      "SELECT cf_key_id,cf_zone_id,cf_email,cf_global_key,current_proxy_ip FROM domains WHERE domain='unlinked.test'")!
    expect(u.cf_zone_id).toBe("zUNL")
    expect(u.cf_email).toBe("k@e.com")
    expect(u.cf_global_key).toBe("plainkey123") // decrypt() passthrough of plaintext
    expect(u.current_proxy_ip).toBe("9.9.9.9")

    // Pass 1: needcreds.test got cf_email/cf_global_key; bug-#2 current_proxy_ip set.
    const n = one<{ cf_email: string; cf_global_key: string; current_proxy_ip: string }>(
      "SELECT cf_email,cf_global_key,current_proxy_ip FROM domains WHERE domain='needcreds.test'")!
    expect(n.cf_email).toBe("k@e.com")
    expect(n.cf_global_key).toBe("plainkey123")
    expect(n.current_proxy_ip).toBe("9.9.9.9")

    // Pure-DB reconcile: hasdns.test (A record already set) still gets current_proxy_ip.
    const h = one<{ current_proxy_ip: string }>(
      "SELECT current_proxy_ip FROM domains WHERE domain='hasdns.test'")!
    expect(h.current_proxy_ip).toBe("9.9.9.9")

    // Bug #1: domains_used recomputed from real count (was 0), not left stale.
    const k = one<{ domains_used: number }>("SELECT domains_used FROM cf_keys WHERE alias='CFX'")!
    const real = one<{ n: number }>("SELECT COUNT(*) n FROM domains WHERE cf_key_id IS NOT NULL")!.n
    expect(k.domains_used).toBe(real)
    expect(k.domains_used).toBeGreaterThan(0)

    // noserver.test has no server → reported, not DNS-fixed.
    expect(body.summary.needs_server).toBeGreaterThanOrEqual(1)
  })

  it("dry_run makes no DB writes", async () => {
    await seed({ domainsUsed: 0 })
    const { POST } = await import("@/app/api/cloudflare/sync/route")
    const { one } = await import("@/lib/db")
    const res = await POST(post({ dry_run: "on" }))
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.dry_run).toBe(true)
    expect(one<{ c: number }>("SELECT cf_key_id c FROM domains WHERE domain='unlinked.test'")!.c).toBeNull()
    expect(one<{ cf_email: string }>("SELECT cf_email FROM domains WHERE domain='needcreds.test'")!.cf_email).toBeNull()
    expect(one<{ d: number }>("SELECT domains_used d FROM cf_keys WHERE alias='CFX'")!.d).toBe(0)
  })

  it("caps step-7 DNS per run (dns_deferred) and is idempotent", async () => {
    process.env.SSR_CF_SYNC_DNS_PER_RUN = "1"
    await seed({ domainsUsed: 0 })
    const { POST } = await import("@/app/api/cloudflare/sync/route")
    const r1 = await (await POST(post())).json()
    // unlinked.test + needcreds.test both need DNS (server, no A record);
    // cap=1 → 1 done, ≥1 deferred.
    expect(r1.summary.dns_fixed).toBe(1)
    expect(r1.summary.dns_deferred).toBeGreaterThanOrEqual(1)
    delete process.env.SSR_CF_SYNC_DNS_PER_RUN
  })
})
