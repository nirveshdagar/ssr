import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

const verifyEntryFileServed = vi.fn()
vi.mock("@/lib/serveravatar", async (orig) => ({
  ...(await orig<typeof import("@/lib/serveravatar")>()),
  verifyEntryFileServed,
}))
vi.mock("@/lib/notify", () => ({ notify: vi.fn(async () => {}) }))

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  verifyEntryFileServed.mockReset()
  const { run } = await import("@/lib/db")
  run("DELETE FROM domains"); run("DELETE FROM servers"); run("DELETE FROM settings")
  run("DELETE FROM jobs"); run("DELETE FROM audit_log"); run("DELETE FROM pipeline_log")
})

async function seed() {
  const { run, one } = await import("@/lib/db")
  run("INSERT INTO servers (name, ip, status) VALUES ('s', '10.0.0.9', 'ready')")
  const sid = one<{ id: number }>("SELECT id FROM servers WHERE ip='10.0.0.9'")!.id
  const { addDomain, updateDomain } = await import("@/lib/repos/domains")
  for (const [d, st] of [["a.site", "hosted"], ["b.site", "live"], ["c.site", "ssl_installed"]] as const) {
    addDomain(d); updateDomain(d, { server_id: sid, status: st } as never)
  }
  return sid
}
const jobsFor = async (domain: string) => {
  const { all } = await import("@/lib/db")
  return all<{ id: number; payload_json: string }>(
    "SELECT id,payload_json FROM jobs WHERE kind='pipeline.full' AND payload_json LIKE ?",
    `%"domain":"${domain}"%`,
  )
}

describe("autoFixMissingEntryFile — standing entry-file presence heal", () => {
  it("no-op when auto_content_heal_enabled=0 (verify never called)", async () => {
    const { run } = await import("@/lib/db")
    await seed()
    run("INSERT INTO settings(key,value) VALUES('auto_content_heal_enabled','0')")
    const { _internal } = await import("@/lib/auto-heal")
    const r = await _internal.autoFixMissingEntryFile()
    expect(verifyEntryFileServed).not.toHaveBeenCalled()
    expect(r.reuploaded).toHaveLength(0)
  })

  it("default ON: re-fires step 10 ONLY for the definitively-missing domain", async () => {
    await seed()
    verifyEntryFileServed.mockImplementation(async (d: string) => {
      if (d === "a.site") return { verdict: "missing", detail: "served /x has NO index.php" }
      if (d === "b.site") return { verdict: "ok", detail: "served /y (50000 bytes)" }
      return { verdict: "inconclusive", detail: "no served vhost" } // c.site
    })
    const { _internal } = await import("@/lib/auto-heal")
    const r = await _internal.autoFixMissingEntryFile()
    expect(r.reuploaded.map((x) => x.domain)).toEqual(["a.site"])
    const aJobs = await jobsFor("a.site")
    expect(aJobs).toHaveLength(1)
    expect(aJobs[0].payload_json).toContain('"start_from":10')
    expect(await jobsFor("b.site")).toHaveLength(0)
    expect(await jobsFor("c.site")).toHaveLength(0)
    const { one } = await import("@/lib/db")
    expect(one<{ n: number }>(
      "SELECT COUNT(*) n FROM audit_log WHERE action='entry_file_missing' AND target='a.site'")!.n,
    ).toBe(1)
  })

  it("gives up (no new job) once the per-hour cap is hit", async () => {
    await seed()
    const { run } = await import("@/lib/db")
    for (let i = 0; i < 3; i++) {
      // detail must carry the build-SHA marker — the cap is build-aware
      // (recentHealFailsThisBuild filters detail LIKE %sha=<BUILD_SHA>%;
      // BUILD_SHA = SSR_GIT_SHA||'dev', unset in tests → 'dev').
      run("INSERT INTO audit_log(action,target,detail,created_at) VALUES('entry_file_missing','a.site','x sha=dev',datetime('now'))")
    }
    verifyEntryFileServed.mockImplementation(async (d: string) =>
      d === "a.site" ? { verdict: "missing", detail: "still missing" }
        : { verdict: "ok", detail: "fine" })
    const { _internal } = await import("@/lib/auto-heal")
    const r = await _internal.autoFixMissingEntryFile()
    expect(r.gaveUp).toContain("a.site")
    expect(r.reuploaded).toHaveLength(0)
    expect(await jobsFor("a.site")).toHaveLength(0) // capped → no new enqueue
  })

  it("build-SHA reset: prior-BUILD failures do NOT cap the new build (the meta-fix)", async () => {
    await seed()
    const { run } = await import("@/lib/db")
    // 5 failures, but all tagged with a DIFFERENT (old) build SHA — i.e.
    // they happened under the buggy code, before a fix was deployed.
    for (let i = 0; i < 5; i++) {
      run("INSERT INTO audit_log(action,target,detail,created_at) VALUES('entry_file_missing','a.site','x sha=OLDBUILD9',datetime('now'))")
    }
    verifyEntryFileServed.mockImplementation(async (d: string) =>
      d === "a.site" ? { verdict: "missing", detail: "still missing" }
        : { verdict: "ok", detail: "fine" })
    const { _internal } = await import("@/lib/auto-heal")
    const r = await _internal.autoFixMissingEntryFile()
    // Current build sees 0 of its own failures → cap released → it RE-FIRES
    // (no manual kick). This is exactly the deploy-auto-resets-cap behavior.
    expect(r.gaveUp).not.toContain("a.site")
    expect(r.reuploaded.map((x) => x.domain)).toContain("a.site")
    expect(await jobsFor("a.site")).toHaveLength(1)
  })
})
