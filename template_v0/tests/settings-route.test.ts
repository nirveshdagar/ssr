import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { NextRequest } from "next/server"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })
beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM settings")
})

function postJson(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/**
 * Regression: sites_per_server / cf_domains_per_key were rendered in
 * Settings and read by the backend, but were absent from the route's
 * STRING_FIELDS allowlist — so POST silently dropped the save and the
 * field always reverted to its 60/20 placeholder.
 */
describe("POST/GET /api/settings — server/CF default caps persist", () => {
  it("persists sites_per_server and cf_domains_per_key", async () => {
    const route = await import("@/app/api/settings/route")
    const { getSetting } = await import("@/lib/repos/settings")

    const res = await route.POST(postJson({ sites_per_server: "100", cf_domains_per_key: "50" }))
    expect((await res.json()).ok ?? true).toBeTruthy()

    expect(getSetting("sites_per_server")).toBe("100")
    expect(getSetting("cf_domains_per_key")).toBe("50")

    // And GET returns them (so the UI shows 100, not the placeholder).
    // GET nests values under `settings`.
    const got = await (await route.GET(new NextRequest("http://localhost/api/settings"))).json()
    expect(got.settings.sites_per_server).toBe("100")
    expect(got.settings.cf_domains_per_key).toBe("50")
  })
})
