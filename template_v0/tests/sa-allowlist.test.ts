import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM servers")
})

/**
 * Security gate. The SSH/SFTP control plane (sa-control + /api/sa/*) takes
 * server_ip from the request and opens an SSH connection to it.
 * assertKnownServerIp is the allowlist that stops an attacker pointing it
 * at an arbitrary host. It had zero tests despite being security-critical.
 */
describe("assertKnownServerIp — SSH allowlist gate", () => {
  it("returns the row for a known fleet IP", async () => {
    const { addServer } = await import("@/lib/repos/servers")
    addServer("box1", "203.0.113.10")
    const { assertKnownServerIp } = await import("@/lib/repos/servers")
    const row = assertKnownServerIp("203.0.113.10")
    expect(row.ip).toBe("203.0.113.10")
  })

  it("THROWS for an IP not in the servers table (the attack it blocks)", async () => {
    const { assertKnownServerIp } = await import("@/lib/repos/servers")
    expect(() => assertKnownServerIp("1.2.3.4"))
      .toThrowError(/not a known dashboard server/)
  })

  it("does not match a substring / different IP", async () => {
    const { addServer, assertKnownServerIp, findServerByIp } = await import("@/lib/repos/servers")
    addServer("box2", "203.0.113.20")
    expect(findServerByIp("203.0.113.2")).toBeUndefined()
    expect(() => assertKnownServerIp("203.0.113.200")).toThrowError(/not a known/)
  })
})
