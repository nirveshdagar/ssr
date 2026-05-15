import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM cf_keys")
  run("DELETE FROM servers")
  run("DELETE FROM settings")
})

describe("preflight (offline checks only)", () => {
  it("checkCfPool fails on empty pool", async () => {
    const { checkCfPool } = await import("@/lib/preflight")
    const r = checkCfPool()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/No active CF keys/)
  })

  it("checkCfPool reports capacity correctly when key has space", async () => {
    const { addCfKey } = await import("@/lib/cf-key-pool")
    const { checkCfPool } = await import("@/lib/preflight")
    addCfKey({ email: "p@x.com", apiKey: "k", maxDomains: 20 })
    const r = checkCfPool()
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/20 domain slot/)
  })

  it("checkLlmKey fails when no key is configured", async () => {
    const { checkLlmKey } = await import("@/lib/preflight")
    const r = checkLlmKey()
    expect(r.ok).toBe(false)
  })

  it("checkLlmKey passes when generic llm_api_key is set", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    const { checkLlmKey } = await import("@/lib/preflight")
    setSetting("llm_api_key", "sk-test-12345")
    const r = checkLlmKey()
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/key configured/)
  })

  it("checkLlmKey prefers per-provider key over generic", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    const { checkLlmKey } = await import("@/lib/preflight")
    setSetting("llm_provider", "openai")
    setSetting("llm_api_key_openai", "sk-openai-specific")
    const r = checkLlmKey()
    expect(r.ok).toBe(true)
  })

  it("checkRootPassword fails when missing, passes when set", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    const { checkRootPassword } = await import("@/lib/preflight")
    expect(checkRootPassword().ok).toBe(false)
    setSetting("server_root_password", "pwd123")
    expect(checkRootPassword().ok).toBe(true)
  })

  it("checkServerCapacity fails when no servers", async () => {
    const { checkServerCapacity } = await import("@/lib/preflight")
    const r = checkServerCapacity()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/No ready servers/)
  })

  it("checkSpaceshipAuth skipped when skipPurchase=true", async () => {
    const { checkSpaceshipAuth } = await import("@/lib/preflight")
    const r = await checkSpaceshipAuth({ skipPurchase: true })
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/Skipped/)
  })
})
