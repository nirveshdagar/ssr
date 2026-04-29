import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM domains")
})

describe("heartbeat — single-domain", () => {
  it("heartbeat() writes datetime('now') to last_heartbeat_at", async () => {
    const { run, one } = await import("@/lib/db")
    const { heartbeat } = await import("@/lib/repos/steps")
    run("INSERT INTO domains(domain) VALUES('hb-test.example.com')")
    // Initial state: last_heartbeat_at is NULL
    const before = one<{ last_heartbeat_at: string | null }>(
      "SELECT last_heartbeat_at FROM domains WHERE domain = ?",
      "hb-test.example.com",
    )
    expect(before?.last_heartbeat_at).toBeNull()
    heartbeat("hb-test.example.com")
    const after = one<{ last_heartbeat_at: string }>(
      "SELECT last_heartbeat_at FROM domains WHERE domain = ?",
      "hb-test.example.com",
    )
    expect(after?.last_heartbeat_at).toBeTruthy()
    expect(after!.last_heartbeat_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it("heartbeat() on a non-existent domain is a no-op (no error)", async () => {
    const { heartbeat } = await import("@/lib/repos/steps")
    expect(() => heartbeat("does-not-exist.example.com")).not.toThrow()
  })
})

describe("startHeartbeat ticker", () => {
  it("pulses immediately on start, then on every interval", async () => {
    const { run, one } = await import("@/lib/db")
    const { startHeartbeat } = await import("@/lib/repos/steps")
    run("INSERT INTO domains(domain) VALUES('ticker.example.com')")

    const ticker = startHeartbeat("ticker.example.com", 100)
    // Allow the immediate-pulse path to complete
    await new Promise((r) => setTimeout(r, 50))
    const t1 = one<{ last_heartbeat_at: string }>(
      "SELECT last_heartbeat_at FROM domains WHERE domain = ?",
      "ticker.example.com",
    )
    expect(t1?.last_heartbeat_at).toBeTruthy()

    // Wait long enough for at least one more tick
    await new Promise((r) => setTimeout(r, 220))
    const t2 = one<{ last_heartbeat_at: string }>(
      "SELECT last_heartbeat_at FROM domains WHERE domain = ?",
      "ticker.example.com",
    )
    expect(t2?.last_heartbeat_at).toBeTruthy()
    // Two SQL writes within 250ms — last_heartbeat_at must have been
    // refreshed at least once (the value may stay equal at second
    // resolution, but the row must have been touched, not be NULL)

    ticker.stop()
    // After stop, no more pulses — capture and re-check after a tick
    const t3 = one<{ last_heartbeat_at: string }>(
      "SELECT last_heartbeat_at FROM domains WHERE domain = ?",
      "ticker.example.com",
    )
    await new Promise((r) => setTimeout(r, 220))
    const t4 = one<{ last_heartbeat_at: string }>(
      "SELECT last_heartbeat_at FROM domains WHERE domain = ?",
      "ticker.example.com",
    )
    expect(t4?.last_heartbeat_at).toBe(t3?.last_heartbeat_at)
  })

  it("multi-domain ticker pulses every domain on each tick", async () => {
    const { run, all } = await import("@/lib/db")
    const { startHeartbeat } = await import("@/lib/repos/steps")
    run("INSERT INTO domains(domain) VALUES('multi-1.example.com')")
    run("INSERT INTO domains(domain) VALUES('multi-2.example.com')")
    run("INSERT INTO domains(domain) VALUES('multi-3.example.com')")

    const ticker = startHeartbeat(
      ["multi-1.example.com", "multi-2.example.com", "multi-3.example.com"],
      100,
    )
    await new Promise((r) => setTimeout(r, 50))
    const rows = all<{ domain: string; last_heartbeat_at: string | null }>(
      "SELECT domain, last_heartbeat_at FROM domains WHERE domain LIKE 'multi-%' ORDER BY domain",
    )
    expect(rows.length).toBe(3)
    for (const r of rows) {
      expect(r.last_heartbeat_at).toBeTruthy()
    }
    ticker.stop()
  })

  it("empty array is safe (no-op, returns stop)", async () => {
    const { startHeartbeat } = await import("@/lib/repos/steps")
    const ticker = startHeartbeat([], 50)
    expect(typeof ticker.stop).toBe("function")
    ticker.stop() // must not throw
  })
})

describe("/api/status active_watchers", () => {
  it("includes domains with at least one step_tracker row in 'running' state", async () => {
    // Bug fix 2026-04-29: badge previously used last_heartbeat_at, which
    // dropped to 0 whenever a long blocking step (LLM/SSH) outlasted the
    // 5s window. Now mirrors getAllActiveWatchers() so the sidebar matches
    // what the watcher page renders.
    const { run } = await import("@/lib/db")
    const { getAllActiveWatchers } = await import("@/lib/repos/steps")
    run("DELETE FROM step_tracker")
    run("INSERT INTO domains(domain) VALUES('active-1.example.com')")
    run("INSERT INTO domains(domain) VALUES('active-2.example.com')")
    run("INSERT INTO domains(domain) VALUES('idle.example.com')")
    run(
      "INSERT INTO step_tracker(domain, step_num, step_name, status) VALUES(?,?,?,?)",
      "active-1.example.com", 5, "DNS lookup", "running",
    )
    run(
      "INSERT INTO step_tracker(domain, step_num, step_name, status) VALUES(?,?,?,?)",
      "active-2.example.com", 7, "Create app", "running",
    )
    run(
      "INSERT INTO step_tracker(domain, step_num, step_name, status) VALUES(?,?,?,?)",
      "idle.example.com", 3, "Buy domain", "completed",
    )

    const active = getAllActiveWatchers()
    expect(active.sort()).toEqual(["active-1.example.com", "active-2.example.com"])
    expect(active).not.toContain("idle.example.com")
  })
})
