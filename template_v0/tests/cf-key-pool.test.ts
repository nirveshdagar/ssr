import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM domains")
  run("DELETE FROM cf_keys")
})

describe("cf-key-pool", () => {
  it("getNextAvailableCfKey throws when pool is empty", async () => {
    const { getNextAvailableCfKey, CFKeyPoolExhausted } = await import("@/lib/cf-key-pool")
    expect(() => getNextAvailableCfKey()).toThrow(CFKeyPoolExhausted)
  })

  it("addCfKey + getNextAvailable returns the key with capacity", async () => {
    const { addCfKey, getNextAvailableCfKey } = await import("@/lib/cf-key-pool")
    const id = addCfKey({ email: "a@x.com", apiKey: "k1", maxDomains: 5 })
    expect(id).toBeGreaterThan(0)
    const next = getNextAvailableCfKey()
    expect(next.email).toBe("a@x.com")
    expect(next.domains_used).toBe(0)
    expect(next.max_domains).toBe(5)
  })

  it("assignCfKeyToDomain increments domains_used + populates the domain row", async () => {
    const { run, one } = await import("@/lib/db")
    const { addCfKey, assignCfKeyToDomain } = await import("@/lib/cf-key-pool")
    addCfKey({ email: "b@x.com", apiKey: "k2", cfAccountId: "acct-b", maxDomains: 3 })
    run("INSERT INTO domains(domain) VALUES('a.example.com')")
    const r1 = assignCfKeyToDomain("a.example.com")
    expect(r1.email).toBe("b@x.com")
    expect(r1.domains_used).toBe(1)
    const d = one<{ cf_email: string; cf_global_key: string; cf_account_id: string }>(
      "SELECT cf_email, cf_global_key, cf_account_id FROM domains WHERE domain = ?",
      "a.example.com",
    )
    expect(d?.cf_email).toBe("b@x.com")
    expect(d?.cf_global_key).toBe("k2")
    expect(d?.cf_account_id).toBe("acct-b")
  })

  it("idempotent: re-assigning the same domain doesn't double-count", async () => {
    const { run } = await import("@/lib/db")
    const { addCfKey, assignCfKeyToDomain } = await import("@/lib/cf-key-pool")
    addCfKey({ email: "c@x.com", apiKey: "k3", maxDomains: 5 })
    run("INSERT INTO domains(domain) VALUES('b.example.com')")
    const a = assignCfKeyToDomain("b.example.com")
    const b = assignCfKeyToDomain("b.example.com")
    expect(a.domains_used).toBe(1)
    expect(b.domains_used).toBe(1) // unchanged on second call
  })

  it("releaseCfKeySlot decrements the counter", async () => {
    const { run } = await import("@/lib/db")
    const { addCfKey, assignCfKeyToDomain, releaseCfKeySlot, listCfKeys } =
      await import("@/lib/cf-key-pool")
    addCfKey({ email: "d@x.com", apiKey: "k4", maxDomains: 5 })
    run("INSERT INTO domains(domain) VALUES('c.example.com')")
    assignCfKeyToDomain("c.example.com")
    expect(listCfKeys()[0].domains_used).toBe(1)
    releaseCfKeySlot("c.example.com")
    expect(listCfKeys()[0].domains_used).toBe(0)
  })

  it("CFKeyPoolExhausted when every key is at max", async () => {
    const { run } = await import("@/lib/db")
    const { addCfKey, assignCfKeyToDomain, CFKeyPoolExhausted } = await import("@/lib/cf-key-pool")
    addCfKey({ email: "e@x.com", apiKey: "k5", maxDomains: 1 })
    run("INSERT INTO domains(domain) VALUES('first.example.com')")
    run("INSERT INTO domains(domain) VALUES('second.example.com')")
    assignCfKeyToDomain("first.example.com")
    expect(() => assignCfKeyToDomain("second.example.com")).toThrow(CFKeyPoolExhausted)
  })
})
