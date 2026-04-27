import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM settings")
})

describe("notify master switch + dedupe", () => {
  it("returns 'skipped: notifications_enabled is off' by default", async () => {
    const { notify } = await import("@/lib/notify")
    const r = await notify("subject", "body", { blocking: true })
    expect(r.skipped).toMatch(/notifications_enabled is off/)
  })

  it("dedupe key skips a second call within the 10-min window", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    const { notify } = await import("@/lib/notify")
    setSetting("notifications_enabled", "1")
    // Pass channels: [] so we don't actually fire any channel
    const r1 = await notify("test-subject", "body-1", {
      blocking: true, channels: [], dedupeKey: "k:dedupe-test",
    })
    expect(r1.skipped).toBeUndefined()
    expect(r1.channels).toEqual([])

    const r2 = await notify("test-subject", "body-2", {
      blocking: true, channels: [], dedupeKey: "k:dedupe-test",
    })
    expect(r2.skipped).toMatch(/deduped/)
    expect(r2.key).toBe("k:dedupe-test")
  })

  it("different dedupe keys both fire", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    const { notify } = await import("@/lib/notify")
    setSetting("notifications_enabled", "1")
    const r1 = await notify("a", "x", { blocking: true, channels: [], dedupeKey: "k:a" })
    const r2 = await notify("b", "x", { blocking: true, channels: [], dedupeKey: "k:b" })
    expect(r1.skipped).toBeUndefined()
    expect(r2.skipped).toBeUndefined()
  })

  it("notify with no dedupe key fires repeatedly", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    const { notify } = await import("@/lib/notify")
    setSetting("notifications_enabled", "1")
    const r1 = await notify("a", "x", { blocking: true, channels: [] })
    const r2 = await notify("a", "x", { blocking: true, channels: [] })
    expect(r1.skipped).toBeUndefined()
    expect(r2.skipped).toBeUndefined()
  })

  it("notifyStatus returns the per-channel last-status snapshot", async () => {
    const { notifyStatus } = await import("@/lib/notify")
    const s = notifyStatus()
    expect(Object.keys(s).sort()).toEqual(["email", "sms", "telegram", "whatsapp"])
  })
})
