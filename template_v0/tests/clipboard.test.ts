import { afterEach, describe, expect, it, vi } from "vitest"
import { copyText } from "@/lib/clipboard"

afterEach(() => { vi.unstubAllGlobals() })

describe("copyText — HTTP-safe clipboard", () => {
  it("uses navigator.clipboard when available", async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    expect(await copyText("hello")).toBe(true)
    expect(writeText).toHaveBeenCalledWith("hello")
  })

  it("does NOT throw when navigator.clipboard is undefined (the HTTP bug)", async () => {
    vi.stubGlobal("navigator", {}) // secure-context API absent, like prod HTTP
    // No DOM in node test env → fallback can't run → false, but never throws.
    await expect(copyText("x")).resolves.toBe(false)
  })

  it("falls back (no throw) when clipboard.writeText rejects", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(async () => { throw new Error("denied") }) },
    })
    await expect(copyText("x")).resolves.toBe(false)
  })
})
