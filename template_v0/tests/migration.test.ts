import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM domains")
})

describe("migration archive roundtrip", () => {
  it("archiveSite + readArchive preserves bytes + metadata", async () => {
    const { run } = await import("@/lib/db")
    run("INSERT INTO domains(domain) VALUES('archive-test.example.com')")
    const { archiveSite, readArchive, deleteArchive } = await import("@/lib/migration")
    const probe = "<!DOCTYPE html><html><body>archive roundtrip</body></html>"
    const path = await archiveSite("archive-test.example.com", probe, { niche: "unit-test" })
    expect(path).toMatch(/archive-test\.example\.com\.tar\.gz$/)
    const back = await readArchive("archive-test.example.com")
    expect(back?.php).toBe(probe)
    expect(back?.meta.niche).toBe("unit-test")
    expect(back?.meta.bytes).toBe(probe.length)
    expect((back?.meta.sha256 as string).length).toBe(64)
    expect(deleteArchive("archive-test.example.com")).toBe(true)
  })

  it("readArchive returns null when no archive file exists", async () => {
    const { readArchive } = await import("@/lib/migration")
    const r = await readArchive("nonexistent.example.com")
    expect(r).toBeNull()
  })

  it("archive path validation rejects path traversal", async () => {
    const { archiveSite } = await import("@/lib/migration")
    await expect(archiveSite("../etc/passwd", "x", {})).rejects.toThrow(/refuse/)
    await expect(archiveSite("foo/../bar", "x", {})).rejects.toThrow(/refuse/)
  })

  it("saveOriginCert writes both cert + key columns", async () => {
    const { run, one } = await import("@/lib/db")
    run("INSERT INTO domains(domain) VALUES('cert-test.example.com')")
    const { saveOriginCert } = await import("@/lib/migration")
    saveOriginCert("cert-test.example.com", "-----BEGIN CERT-----\nABC\n-----END CERT-----",
                                            "-----BEGIN KEY-----\nXYZ\n-----END KEY-----")
    const r = one<{ origin_cert_pem: string; origin_key_pem: string }>(
      "SELECT origin_cert_pem, origin_key_pem FROM domains WHERE domain = ?",
      "cert-test.example.com",
    )
    expect(r?.origin_cert_pem).toContain("BEGIN CERT")
    expect(r?.origin_key_pem).toContain("BEGIN KEY")
  })
})
