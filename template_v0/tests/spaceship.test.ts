import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM settings")
  const { setSetting } = await import("@/lib/repos/settings")
  setSetting("spaceship_api_key", "test-key")
  setSetting("spaceship_api_secret", "test-secret")
  vi.restoreAllMocks()
})

afterEach(() => { vi.restoreAllMocks() })

function stubFetchJson(body: unknown) {
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  )
}

describe("checkAvailability — Spaceship response-shape normalization", () => {
  // Regression: the live API returns { domain, result:"available" }, not the
  // once-assumed { name, isAvailable }. The old cast made Boolean(undefined)
  // === false for every domain, so step1BuyOrDetect never bought and
  // mislabeled available domains as "registered elsewhere".
  it("maps the real { domain, result } shape to { name, isAvailable:true }", async () => {
    stubFetchJson({ domains: [{ domain: "canvasdigital.site", result: "available", premiumPricing: [] }] })
    const { checkAvailability } = await import("@/lib/spaceship")
    const r = await checkAvailability("canvasdigital.site")
    expect(r.domains).toEqual([{ name: "canvasdigital.site", isAvailable: true }])
  })

  it("treats result !== 'available' as unavailable", async () => {
    stubFetchJson({ domains: [{ domain: "taken.site", result: "unavailable", premiumPricing: [] }] })
    const { checkAvailability } = await import("@/lib/spaceship")
    const r = await checkAvailability("taken.site")
    expect(r.domains[0]).toEqual({ name: "taken.site", isAvailable: false })
  })

  it("still accepts the legacy { name, isAvailable } shape", async () => {
    stubFetchJson({ domains: [{ name: "legacy.site", isAvailable: true }] })
    const { checkAvailability } = await import("@/lib/spaceship")
    const r = await checkAvailability("legacy.site")
    expect(r.domains[0]).toEqual({ name: "legacy.site", isAvailable: true })
  })
})
