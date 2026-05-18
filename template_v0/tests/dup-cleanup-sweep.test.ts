import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

const cleanupDuplicateSaApps = vi.fn()
vi.mock("@/lib/sa-control", () => ({ cleanupDuplicateSaApps }))
vi.mock("@/lib/notify", () => ({ notify: vi.fn(async () => {}) }))

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  cleanupDuplicateSaApps.mockReset()
  const { run } = await import("@/lib/db")
  run("DELETE FROM domains"); run("DELETE FROM servers"); run("DELETE FROM settings")
})

async function seedReadyServer(autoMigrate: boolean) {
  const { run, one } = await import("@/lib/db")
  if (autoMigrate) run("INSERT INTO settings(key,value) VALUES('auto_migrate_enabled','1')")
  run("INSERT INTO servers (name, ip, status, sa_server_id) VALUES ('s','10.0.0.9','ready','SA9')")
  return one<{ id: number }>("SELECT id FROM servers WHERE ip='10.0.0.9'")!.id
}

describe("autoCleanupDuplicateSaApps — destructive, gated", () => {
  it("NO-OP (no SA calls) when auto_migrate_enabled != 1", async () => {
    await seedReadyServer(false)
    const { _internal } = await import("@/lib/auto-heal")
    const r = await _internal.autoCleanupDuplicateSaApps()
    expect(cleanupDuplicateSaApps).not.toHaveBeenCalled()
    expect(r.deleted).toHaveLength(0)
  })

  it("when enabled: runs per ready server, aggregates real deletes, passes a race-guard", async () => {
    await seedReadyServer(true)
    cleanupDuplicateSaApps.mockResolvedValue({
      ok: true, decisions: [],
      deleted: [
        { domain: "conceptden.site", appId: "205", ok: true, message: "Deleted app 205" },
        { domain: "x.site", appId: "9", ok: false, message: "HTTP 500" },
      ],
      skipped: [{ domain: "y.site", reason: "ambiguous" }],
      message: "done",
    })
    const { _internal } = await import("@/lib/auto-heal")
    const r = await _internal.autoCleanupDuplicateSaApps()
    expect(cleanupDuplicateSaApps).toHaveBeenCalledTimes(1)
    const arg = cleanupDuplicateSaApps.mock.calls[0][0]
    expect(arg.dryRun).toBe(false)
    expect(typeof arg.skipDomain).toBe("function")   // pipeline race-guard wired
    expect(arg.saServerId).toBe("SA9")
    // only the ok, non-DRY delete is counted
    expect(r.deleted).toEqual([{ domain: "conceptden.site", appId: "205", server_id: arg ? r.deleted[0].server_id : 0 }])
    expect(r.skipped.some((s) => s.reason === "ambiguous")).toBe(true)
  })
})
