import { describe, it, expect } from "vitest"
import { missingRequiredSettings, REQUIRED_SETTINGS } from "@/lib/required-settings"

describe("missingRequiredSettings", () => {
  it("flags blank/whitespace/missing values, accepts set ones", () => {
    const all: Record<string, string> = {}
    for (const f of REQUIRED_SETTINGS) all[f.key] = "set"
    expect(missingRequiredSettings(all)).toEqual([])

    const partial = { ...all, registrant_email: "", spaceship_api_secret: "   " }
    delete (partial as Record<string, unknown>).do_api_token
    const missing = missingRequiredSettings(partial).map((f) => f.key).sort()
    expect(missing).toEqual(["do_api_token", "registrant_email", "spaceship_api_secret"])
  })

  it("treats null/undefined input as everything missing", () => {
    expect(missingRequiredSettings(null)).toHaveLength(REQUIRED_SETTINGS.length)
    expect(missingRequiredSettings(undefined)).toHaveLength(REQUIRED_SETTINGS.length)
  })
})
