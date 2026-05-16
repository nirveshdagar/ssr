import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const runAll = vi.fn(async () => ({
  ok: false,
  checks: { spaceship_auth: { ok: false, message: "not configured" } },
}))
vi.mock("@/lib/preflight", () => ({ runAll }))

beforeEach(() => { runAll.mockClear() })

describe("GET /api/preflight (global config health)", () => {
  it("returns the runAll() report as JSON", async () => {
    const { GET } = await import("@/app/api/preflight/route")
    const res = await GET(new NextRequest("http://localhost/api/preflight"))
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.checks.spaceship_auth.ok).toBe(false)
    expect(runAll).toHaveBeenCalledWith({ skipPurchase: false })
  })

  it("passes skip_purchase through", async () => {
    const { GET } = await import("@/app/api/preflight/route")
    await GET(new NextRequest("http://localhost/api/preflight?skip_purchase=on"))
    expect(runAll).toHaveBeenCalledWith({ skipPurchase: true })
  })
})
