import { describe, it, expect } from "vitest"
import { ExternalApiShapeError, requireShape, snippetOf } from "@/lib/ext-api"

describe("ext-api fail-loud guards", () => {
  it("requireShape returns the value when ok() holds", () => {
    const v = requireShape<{ a: number }>("test", { a: 1 }, (x) => typeof x === "object")
    expect(v.a).toBe(1)
  })

  it("requireShape throws ExternalApiShapeError when shape is unrecognized", () => {
    expect(() => requireShape("spaceship", { wrong: true }, () => false))
      .toThrowError(ExternalApiShapeError)
  })

  it("accepts benign empty/negative results (only structure is checked)", () => {
    // An empty array is a *valid* result, must NOT throw.
    const ok = (v: unknown) =>
      !!v && typeof v === "object" && Array.isArray((v as { domains?: unknown }).domains)
    expect(requireShape("x", { domains: [] }, ok)).toEqual({ domains: [] })
  })

  it("snippetOf truncates and redacts secret-ish values", () => {
    const s = snippetOf({ apiKey: "supersecret", note: "ok" })
    expect(s).not.toContain("supersecret")
    expect(s).toContain('"***"')
    expect(snippetOf("x".repeat(500)).length).toBeLessThanOrEqual(301)
  })
})
