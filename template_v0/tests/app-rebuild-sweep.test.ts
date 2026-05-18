import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

const findAppId = vi.fn()
const listApplications = vi.fn()
const deleteApplicationById = vi.fn()
const pathExistsOnServer = vi.fn()
vi.mock("@/lib/serveravatar", async (orig) => ({
  ...(await orig<typeof import("@/lib/serveravatar")>()),
  findAppId, listApplications, deleteApplicationById,
}))
vi.mock("@/lib/sa-control", async (orig) => ({
  ...(await orig<typeof import("@/lib/sa-control")>()),
  pathExistsOnServer,
}))
vi.mock("@/lib/notify", () => ({ notify: vi.fn(async () => {}) }))

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  findAppId.mockReset(); listApplications.mockReset()
  deleteApplicationById.mockReset(); pathExistsOnServer.mockReset()
  const { run } = await import("@/lib/db")
  run("DELETE FROM domains"); run("DELETE FROM servers"); run("DELETE FROM settings")
  run("DELETE FROM jobs"); run("DELETE FROM audit_log"); run("DELETE FROM pipeline_log")
})

async function seed(autoMigrate = true) {
  const { run, one } = await import("@/lib/db")
  if (autoMigrate) {
    run("INSERT INTO settings(key,value) VALUES('auto_migrate_enabled','1')")
    // destructive sweep now also requires its own explicit opt-in
    run("INSERT INTO settings(key,value) VALUES('auto_destructive_sa_heal_enabled','1')")
  }
  run("INSERT INTO servers (name, ip, status, sa_server_id) VALUES ('s','10.0.0.9','ready','SA9')")
  const sid = one<{ id: number }>("SELECT id FROM servers WHERE ip='10.0.0.9'")!.id
  const { addDomain, updateDomain } = await import("@/lib/repos/domains")
  addDomain("conceptden.site")
  updateDomain("conceptden.site", { server_id: sid, status: "retryable_error" } as never)
  // candidate signal: entry-heal already gave up on it
  run("INSERT INTO audit_log(action,target,detail,created_at) VALUES('entry_heal_giveup','conceptden.site','x',datetime('now'))")
}
const jobs = async () => {
  const { all } = await import("@/lib/db")
  return all<{ payload_json: string }>(
    "SELECT payload_json FROM jobs WHERE kind='pipeline.full' AND payload_json LIKE ?",
    '%"domain":"conceptden.site"%')
}

describe("autoRebuildUnscaffoldedApp — escalation, destructive, gated", () => {
  it("no-op when auto_migrate_enabled != 1", async () => {
    await seed(false)
    const { _internal } = await import("@/lib/auto-heal")
    const r = await _internal.autoRebuildUnscaffoldedApp()
    expect(findAppId).not.toHaveBeenCalled()
    expect(r.rebuilt).toHaveLength(0)
  })

  it("no SA app → rebuild from step 6, no delete", async () => {
    await seed()
    findAppId.mockResolvedValue(null)
    const { _internal } = await import("@/lib/auto-heal")
    const r = await _internal.autoRebuildUnscaffoldedApp()
    expect(r.rebuilt.map((x) => x.state)).toEqual(["no-sa-app"])
    expect(deleteApplicationById).not.toHaveBeenCalled()
    const j = await jobs()
    expect(j).toHaveLength(1)
    expect(j[0].payload_json).toContain('"start_from":6')
  })

  it("SA app exists but its dir doesn't → delete stale record THEN rebuild", async () => {
    await seed()
    findAppId.mockResolvedValue("144852")
    listApplications.mockResolvedValue([
      { id: 144852, name: "conceptden-site", system_user: "purepacksite", primary_domain: "conceptden.site" },
    ])
    pathExistsOnServer.mockResolvedValue(false) // /home/purepacksite/conceptden-site missing
    const { _internal } = await import("@/lib/auto-heal")
    const r = await _internal.autoRebuildUnscaffoldedApp()
    expect(r.rebuilt.map((x) => x.state)).toEqual(["sa-app-no-dir"])
    expect(deleteApplicationById).toHaveBeenCalledWith("SA9", "144852", "conceptden.site")
    expect(await jobs()).toHaveLength(1)
  })

  it("app dir exists (scaffolded) → skip, no delete/rebuild", async () => {
    await seed()
    findAppId.mockResolvedValue("144852")
    listApplications.mockResolvedValue([
      { id: 144852, name: "conceptden-site", system_user: "purepacksite" },
    ])
    pathExistsOnServer.mockResolvedValue(true)
    const { _internal } = await import("@/lib/auto-heal")
    const r = await _internal.autoRebuildUnscaffoldedApp()
    expect(r.rebuilt).toHaveLength(0)
    expect(deleteApplicationById).not.toHaveBeenCalled()
    expect(await jobs()).toHaveLength(0)
  })

  it("hit per-day cap → giveup, no new rebuild", async () => {
    await seed()
    const { run } = await import("@/lib/db")
    for (let i = 0; i < 2; i++) {
      run("INSERT INTO audit_log(action,target,detail,created_at) VALUES('app_rebuild','conceptden.site','x',datetime('now'))")
    }
    findAppId.mockResolvedValue(null) // no-sa-app, but capped
    const { _internal } = await import("@/lib/auto-heal")
    const r = await _internal.autoRebuildUnscaffoldedApp()
    expect(r.gaveUp).toContain("conceptden.site")
    expect(r.rebuilt).toHaveLength(0)
    expect(await jobs()).toHaveLength(0)
  })
})
