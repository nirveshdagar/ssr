import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

describe("secrets-vault Fernet", () => {
  it("round-trips a string", async () => {
    const { encrypt, decrypt } = await import("@/lib/secrets-vault")
    const plain = "hunter2!@#$"
    const enc = encrypt(plain)
    expect(enc.startsWith("enc:v1:")).toBe(true)
    expect(decrypt(enc)).toBe(plain)
  })

  it("decrypt is a no-op on legacy plaintext (no marker)", async () => {
    const { decrypt } = await import("@/lib/secrets-vault")
    expect(decrypt("plaintext-no-marker")).toBe("plaintext-no-marker")
  })

  it("isSensitive matches both EXACT keys and prefix keys", async () => {
    const { isSensitive } = await import("@/lib/secrets-vault")
    expect(isSensitive("do_api_token")).toBe(true)
    expect(isSensitive("llm_api_key_anthropic")).toBe(true)
    expect(isSensitive("llm_api_key_openrouter")).toBe(true)
    expect(isSensitive("region")).toBe(false)
    expect(isSensitive("max_droplets_per_hour")).toBe(false)
  })

  it("settings repo encrypts on write + decrypts on read transparently", async () => {
    const { setSetting, getSetting } = await import("@/lib/repos/settings")
    setSetting("do_api_token", "dop_secret_xyz")
    expect(getSetting("do_api_token")).toBe("dop_secret_xyz")
    // Verify it's actually encrypted on disk
    const { one } = await import("@/lib/db")
    const row = one<{ value: string }>("SELECT value FROM settings WHERE key = ?", "do_api_token")
    expect(row?.value).toMatch(/^enc:v1:/)
  })

  it("non-sensitive settings stored as plaintext", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    const { one } = await import("@/lib/db")
    setSetting("region", "nyc3")
    const row = one<{ value: string }>("SELECT value FROM settings WHERE key = ?", "region")
    expect(row?.value).toBe("nyc3")
  })
})
