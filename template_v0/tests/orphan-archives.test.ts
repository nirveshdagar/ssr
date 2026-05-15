import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { setupTestDb, cleanupTestDb } from "./_setup"

describe("cleanOrphanArchives", () => {
  beforeEach(() => { setupTestDb() })
  afterEach(() => { cleanupTestDb() })

  it("removes tar.gz files whose domain isn't in the DB; keeps live ones", async () => {
    const { cleanOrphanArchives } = await import("../lib/auto-heal")
    const { archiveDir } = await import("../lib/migration")
    const { addDomain } = await import("../lib/repos/domains")

    const dir = archiveDir()
    mkdirSync(dir, { recursive: true })

    // Two archives: one with a matching DB row, one orphan.
    addDomain("live.example")
    writeFileSync(path.join(dir, "live.example.tar.gz"), "live-payload")
    writeFileSync(path.join(dir, "ghost.example.tar.gz"), "orphan-payload")

    const result = await cleanOrphanArchives()

    expect(result.scanned).toBe(2)
    expect(result.removed).toEqual([{ domain: "ghost.example", bytes: "orphan-payload".length }])
    expect(result.bytes_freed).toBe("orphan-payload".length)

    const left = readdirSync(dir).sort()
    expect(left).toEqual(["live.example.tar.gz"])
    expect(existsSync(path.join(dir, "ghost.example.tar.gz"))).toBe(false)
    expect(existsSync(path.join(dir, "live.example.tar.gz"))).toBe(true)
  })

  it("deleteDomain triggers fire-and-forget archive cleanup", async () => {
    const { archiveDir } = await import("../lib/migration")
    const { addDomain, deleteDomain } = await import("../lib/repos/domains")

    const dir = archiveDir()
    mkdirSync(dir, { recursive: true })

    addDomain("soft-delete.example")
    const tarPath = path.join(dir, "soft-delete.example.tar.gz")
    writeFileSync(tarPath, "payload")
    expect(existsSync(tarPath)).toBe(true)

    deleteDomain("soft-delete.example")

    // The unlink happens via fire-and-forget dynamic import — wait for the
    // microtask queue + a tick for the import resolution.
    await new Promise((r) => setTimeout(r, 100))

    expect(existsSync(tarPath)).toBe(false)
  })
})
