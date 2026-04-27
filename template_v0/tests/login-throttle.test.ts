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
})
