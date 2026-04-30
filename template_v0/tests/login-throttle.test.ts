import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { _resetThrottle } = await import("@/lib/login-throttle")
  _resetThrottle()
})

describe("login-throttle", () => {
  it("allows the first 5 failures then locks", async () => {
    const { loginThrottleCheck, loginThrottleRecord } = await import("@/lib/login-throttle")
    const ip = "10.0.0.1"
    for (let i = 0; i < 5; i++) {
      expect(loginThrottleCheck(ip)).toBe(true)
      loginThrottleRecord(ip, false)
    }
    expect(loginThrottleCheck(ip)).toBe(false) // 6th attempt is throttled
  })

  it("clears the bucket on a successful login", async () => {
    const { loginThrottleCheck, loginThrottleRecord } = await import("@/lib/login-throttle")
    const ip = "10.0.0.2"
    for (let i = 0; i < 4; i++) loginThrottleRecord(ip, false)
    expect(loginThrottleCheck(ip)).toBe(true)
    loginThrottleRecord(ip, true)
    // Now we should have a fresh bucket — 5 more failures allowed
    for (let i = 0; i < 5; i++) {
      expect(loginThrottleCheck(ip)).toBe(true)
      loginThrottleRecord(ip, false)
    }
    expect(loginThrottleCheck(ip)).toBe(false)
  })

  it("retry-after returns 0 when not throttled, >=1 when throttled", async () => {
    const { loginThrottleCheck, loginThrottleRecord, loginThrottleRetryAfter } =
      await import("@/lib/login-throttle")
    const ip = "10.0.0.3"
    expect(loginThrottleRetryAfter(ip)).toBe(0)
    for (let i = 0; i < 5; i++) loginThrottleRecord(ip, false)
    expect(loginThrottleCheck(ip)).toBe(false)
    expect(loginThrottleRetryAfter(ip)).toBeGreaterThanOrEqual(1)
  })

  it("each IP gets its own bucket", async () => {
    const { loginThrottleCheck, loginThrottleRecord } = await import("@/lib/login-throttle")
    for (let i = 0; i < 5; i++) loginThrottleRecord("10.1.1.1", false)
    expect(loginThrottleCheck("10.1.1.1")).toBe(false)
    expect(loginThrottleCheck("10.1.1.2")).toBe(true) // different IP, fresh
  })

  it("checkAndReserve admits exactly MAX_PER_WINDOW under burst (TOCTOU race fix)", async () => {
    // The race fix: a naïve check-then-record sequence let N parallel
    // requests all see length<5 and all proceed. checkAndReserve does
    // check + push in a single synchronous pass, so the (N+1)th sees the
    // bucket full. Verify by firing 20 callers at the same IP and asserting
    // exactly MAX_PER_WINDOW (5) get true.
    const { loginThrottleCheckAndReserve } = await import("@/lib/login-throttle")
    const ip = "10.0.0.99"
    // Fire all calls without awaiting between them — better-sqlite3 isn't
    // involved here (the throttle bucket lives in module memory), but the
    // shape mirrors what N concurrent route handlers would do.
    const results = Array.from({ length: 20 }, () => loginThrottleCheckAndReserve(ip))
    const allowed = results.filter(Boolean).length
    expect(allowed).toBe(5)
    // And the bucket is now properly full — a 21st caller is rejected.
    expect(loginThrottleCheckAndReserve(ip)).toBe(false)
  })
})
