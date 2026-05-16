import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { setupTestDb, cleanupTestDb } from "./_setup"

const listDroplets = vi.fn()
vi.mock("@/lib/digitalocean", () => ({
  listDroplets,
  DOAllTokensFailed: class DOAllTokensFailed extends Error {},
}))

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })
beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM servers")
  listDroplets.mockReset()
})

function droplet(id: string, ip: string) {
  return {
    id, name: `box-${id}`,
    networks: { v4: [{ type: "public", ip_address: ip }] },
    region: { slug: "nyc1" }, size_slug: "s-1vcpu-1gb",
  }
}
const post = () => new NextRequest("http://localhost/api/servers/import-from-do", { method: "POST" })

describe("POST /api/servers/import-from-do — reused-IP regression", () => {
  it("imports a real new droplet even when its IP was recycled from a destroyed one", async () => {
    const { run, one } = await import("@/lib/db")
    // Stale row: droplet OLD was destroyed, but its row + IP still here.
    run("INSERT INTO servers (name, ip, do_droplet_id, status) VALUES ('old','5.5.5.5','OLD','live')")
    // DO now returns only the NEW droplet, on the recycled IP.
    listDroplets.mockResolvedValue([droplet("NEW", "5.5.5.5")])

    const { POST } = await import("@/app/api/servers/import-from-do/route")
    const body = await (await POST(post())).json()

    expect(body.ok).toBe(true)
    expect(body.added).toBe(1) // was 0 before the fix (IP-collision skip)
    expect(one<{ n: number }>("SELECT COUNT(*) n FROM servers WHERE do_droplet_id='NEW'")!.n).toBe(1)
  })

  it("still skips a droplet whose ID is already tracked", async () => {
    const { run } = await import("@/lib/db")
    run("INSERT INTO servers (name, ip, do_droplet_id, status) VALUES ('a','6.6.6.6','LIVE1','active')")
    listDroplets.mockResolvedValue([droplet("LIVE1", "6.6.6.6")])
    const { POST } = await import("@/app/api/servers/import-from-do/route")
    const body = await (await POST(post())).json()
    expect(body.added).toBe(0)
  })

  it("still skips when IP collides with a manual row (no droplet_id) — no duplicate", async () => {
    const { run, one } = await import("@/lib/db")
    run("INSERT INTO servers (name, ip, do_droplet_id, status) VALUES ('manual','7.7.7.7',NULL,'active')")
    listDroplets.mockResolvedValue([droplet("X", "7.7.7.7")])
    const { POST } = await import("@/app/api/servers/import-from-do/route")
    const body = await (await POST(post())).json()
    expect(body.added).toBe(0)
    expect(one<{ n: number }>("SELECT COUNT(*) n FROM servers WHERE ip='7.7.7.7'")!.n).toBe(1)
  })
})
