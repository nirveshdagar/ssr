import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

const quarantineBrokenVhosts = vi.fn()
vi.mock("@/lib/sa-control", () => ({ quarantineBrokenVhosts }))
vi.mock("@/lib/notify", () => ({ notify: vi.fn(async () => {}) }))

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  quarantineBrokenVhosts.mockReset()
  const { run } = await import("@/lib/db")
  run("DELETE FROM domains"); run("DELETE FROM servers"); run("DELETE FROM settings")
})

async function seed(opts: { autoMigrate?: boolean } = {}) {
  const { run } = await import("@/lib/db")
  if (opts.autoMigrate) run("INSERT INTO settings(key,value) VALUES('auto_migrate_enabled','1')")
  run("INSERT INTO servers (name, ip, status) VALUES ('savanna', '10.0.0.9', 'ready')")
  const { one } = await import("@/lib/db")
  const sid = one<{ id: number }>("SELECT id FROM servers WHERE ip='10.0.0.9'")!.id
  const { addDomain, updateDomain } = await import("@/lib/repos/domains")
  addDomain("conceptden.site")
  updateDomain("conceptden.site", { server_id: sid, status: "hosted", live_ok: 0 } as never)
  addDomain("purepack.site")
  updateDomain("purepack.site", { server_id: sid, status: "live", live_ok: 1 } as never)
  return sid
}

describe("autoFixBrokenApacheVhost — gating + flagging", () => {
  it("is a no-op (no SSH) when auto_migrate_enabled != 1", async () => {
    await seed({ autoMigrate: false })
    const { _internal } = await import("@/lib/auto-heal")
    const r = await _internal.autoFixBrokenApacheVhost()
    expect(r.fixed).toHaveLength(0)
    expect(quarantineBrokenVhosts).not.toHaveBeenCalled()
  })

  it("skips a server with no origin-down domains without SSHing", async () => {
    const { run, one } = await import("@/lib/db")
    run("INSERT INTO settings(key,value) VALUES('auto_migrate_enabled','1')")
    run("INSERT INTO servers (name, ip, status) VALUES ('ok-box', '10.0.0.5', 'ready')")
    const sid = one<{ id: number }>("SELECT id FROM servers WHERE ip='10.0.0.5'")!.id
    const { addDomain, updateDomain } = await import("@/lib/repos/domains")
    addDomain("fine.site")
    updateDomain("fine.site", { server_id: sid, status: "live", live_ok: 1 } as never)
    const { _internal } = await import("@/lib/auto-heal")
    const r = await _internal.autoFixBrokenApacheVhost()
    expect(quarantineBrokenVhosts).not.toHaveBeenCalled()
    expect(r.skipped.some((s) => /not a candidate/.test(s.reason))).toBe(true)
  })

  it("parks the broken vhost and flips its domain to retryable_error", async () => {
    await seed({ autoMigrate: true })
    quarantineBrokenVhosts.mockImplementation(async (_ip: string, dry: boolean) => {
      const decision = {
        act: true, reason: "broken",
        quarantine: [{ conf: "/etc/apache2/sites-enabled/conceptden-site-le-ssl.conf", reasons: ["ErrorLog dir missing"] }],
      }
      return dry
        ? { ok: true, acted: false, decision, quarantined: [], configtestOkAfter: false, reloaded: false, message: "dry" }
        : { ok: true, acted: true, decision, quarantined: ["/etc/apache2/sites-enabled/conceptden-site-le-ssl.conf"], configtestOkAfter: true, reloaded: true, message: "parked + reloaded" }
    })
    const { _internal } = await import("@/lib/auto-heal")
    const r = await _internal.autoFixBrokenApacheVhost()
    expect(r.fixed).toHaveLength(1)
    expect(r.fixed[0].quarantined[0]).toContain("conceptden")
    const { getDomain } = await import("@/lib/repos/domains")
    expect(getDomain("conceptden.site")!.status).toBe("retryable_error")
    expect(getDomain("purepack.site")!.status).toBe("live") // untouched
  })

  it("refuses to act (systemic) when too many confs would be parked", async () => {
    await seed({ autoMigrate: true })
    const many = Array.from({ length: 9 }, (_, i) => ({ conf: `/etc/apache2/sites-enabled/s${i}.conf`, reasons: ["x"] }))
    quarantineBrokenVhosts.mockResolvedValue({
      ok: true, acted: false,
      decision: { act: true, reason: "broken", quarantine: many },
      quarantined: [], configtestOkAfter: false, reloaded: false, message: "dry",
    })
    const { _internal } = await import("@/lib/auto-heal")
    const r = await _internal.autoFixBrokenApacheVhost()
    expect(r.fixed).toHaveLength(0)
    expect(r.skipped.some((s) => /SYSTEMIC/.test(s.reason))).toBe(true)
    // never called in live (act) mode — only the dry-run probe
    expect(quarantineBrokenVhosts).toHaveBeenCalledTimes(1)
    expect(quarantineBrokenVhosts).toHaveBeenCalledWith("10.0.0.9", true)
  })
})
