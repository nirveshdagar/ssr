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

interface Call { method: string; url: string; body: string }

/** Route the Spaceship calls purchaseDomain makes:
 *  GET /domains/<d>  -> 404 (not owned, idempotency precheck throws)
 *  PUT /contacts     -> 200 { contactId }
 *  POST /domains/<d> -> 200 (purchase ok). Records every call. */
function installSpaceshipMock(opts: { contactId: string }) {
  const calls: Call[] = []
  vi.stubGlobal("fetch", async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input)
    const method = (init?.method || "GET").toUpperCase()
    calls.push({ method, url, body: typeof init?.body === "string" ? init.body : "" })
    if (method === "GET" && /\/domains\//.test(url)) return new Response("{}", { status: 404 })
    if (method === "PUT" && /\/contacts$/.test(url)) {
      return new Response(JSON.stringify({ contactId: opts.contactId }), { status: 200 })
    }
    if (method === "POST" && /\/domains\//.test(url)) return new Response("{}", { status: 200 })
    return new Response("{}", { status: 500 })
  })
  return calls
}

describe("purchaseDomain — contact-ID payload (Spaceship schema fix)", () => {
  it("creates a contact, then sends string contact IDs + privacyProtection.userConsent", async () => {
    const calls = installSpaceshipMock({ contactId: "CID-NEW" })
    const { purchaseDomain } = await import("@/lib/spaceship")
    const r = await purchaseDomain("buyme.site")
    expect(r.ok).toBe(true)

    expect(calls.some((c) => c.method === "PUT" && /\/contacts$/.test(c.url))).toBe(true)
    const post = calls.find((c) => c.method === "POST" && /\/domains\/buyme\.site$/.test(c.url))
    expect(post).toBeTruthy()
    const payload = JSON.parse(post!.body)
    expect(payload.contacts).toEqual({
      registrant: "CID-NEW", admin: "CID-NEW", tech: "CID-NEW", billing: "CID-NEW",
    })
    expect(payload.privacyProtection).toEqual({ level: "high", userConsent: true })
  })

  it("reuses a cached spaceship_contact_id (no PUT /contacts)", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    setSetting("spaceship_contact_id", "CID-CACHED")
    const calls = installSpaceshipMock({ contactId: "SHOULD-NOT-BE-USED" })
    const { purchaseDomain } = await import("@/lib/spaceship")
    const r = await purchaseDomain("buyme2.site")
    expect(r.ok).toBe(true)
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
    const post = calls.find((c) => c.method === "POST")!
    expect(JSON.parse(post.body).contacts.registrant).toBe("CID-CACHED")
  })
})
