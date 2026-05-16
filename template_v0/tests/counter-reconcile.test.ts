import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM domains")
  run("DELETE FROM cf_keys")
})

describe("reconcileCfKeyCounters — self-heal cf_keys.domains_used", () => {
  it("corrects only the wrong counters and returns how many it fixed", async () => {
    const { run, one } = await import("@/lib/db")
    // k1: stored 0, real 2 (the drift that hit prod)
    run("INSERT INTO cf_keys (email,api_key,domains_used,is_active) VALUES ('k1@e','x',0,1)")
    // k2: stored 1, real 1 — already correct, must be left untouched
    run("INSERT INTO cf_keys (email,api_key,domains_used,is_active) VALUES ('k2@e','x',1,1)")
    // k3: stored 5, real 0 — also wrong (too high)
    run("INSERT INTO cf_keys (email,api_key,domains_used,is_active) VALUES ('k3@e','x',5,1)")
    const k1 = one<{ id: number }>("SELECT id FROM cf_keys WHERE email='k1@e'")!.id
    const k2 = one<{ id: number }>("SELECT id FROM cf_keys WHERE email='k2@e'")!.id

    const { addDomain } = await import("@/lib/repos/domains")
    addDomain("a.test"); addDomain("b.test"); addDomain("c.test")
    run("UPDATE domains SET cf_key_id=? WHERE domain IN ('a.test','b.test')", k1)
    run("UPDATE domains SET cf_key_id=? WHERE domain='c.test'", k2)

    const { reconcileCfKeyCounters } = await import("@/lib/counter-reconcile")
    const fixed = reconcileCfKeyCounters()
    expect(fixed).toBe(2) // k1 and k3 were wrong; k2 was already correct

    const used = (email: string) =>
      one<{ d: number }>("SELECT domains_used d FROM cf_keys WHERE email=?", email)!.d
    expect(used("k1@e")).toBe(2)
    expect(used("k2@e")).toBe(1)
    expect(used("k3@e")).toBe(0)

    // Idempotent — second run corrects nothing.
    expect(reconcileCfKeyCounters()).toBe(0)
  })
})
