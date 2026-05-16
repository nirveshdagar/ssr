import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM domains")
})

describe("domains.watcher_dismissed", () => {
  // Regression guard: the flag must be in DOMAIN_COLS or updateDomain
  // silently drops it (same class of bug as the Spaceship shape cast).
  it("defaults to 0 and round-trips through updateDomain/getDomain", async () => {
    const { addDomain, updateDomain, getDomain } = await import("@/lib/repos/domains")
    addDomain("dismiss-me.site")

    expect(getDomain("dismiss-me.site")?.watcher_dismissed).toBe(0)

    updateDomain("dismiss-me.site", { watcher_dismissed: 1 } as Parameters<typeof updateDomain>[1])
    expect(getDomain("dismiss-me.site")?.watcher_dismissed).toBe(1)

    // Pipeline teardown clears it (cancel_requested + watcher_dismissed).
    updateDomain("dismiss-me.site", {
      cancel_requested: 0, watcher_dismissed: 0,
    } as Parameters<typeof updateDomain>[1])
    expect(getDomain("dismiss-me.site")?.watcher_dismissed).toBe(0)
  })
})
