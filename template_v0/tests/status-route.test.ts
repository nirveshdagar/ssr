import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { NextRequest } from "next/server"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM domains")
  run("DELETE FROM step_tracker")
  run("DELETE FROM pipeline_log")
})

async function watcherRuns(): Promise<number> {
  const { GET } = await import("@/app/api/status/route")
  const res = await GET(new NextRequest("http://t/api/status"))
  const body = await res.json() as { counts: { watcher_runs: number } }
  return body.counts.watcher_runs
}

async function seedDomain(
  name: string, status: string, opts: { running?: boolean; dismissed?: boolean } = {},
) {
  const { addDomain, updateDomain } = await import("@/lib/repos/domains")
  addDomain(name)
  updateDomain(name, { status, watcher_dismissed: opts.dismissed ? 1 : 0 })
  if (opts.running) {
    const { initSteps, updateStep } = await import("@/lib/repos/steps")
    initSteps(name)
    updateStep(name, 5, "running", "in flight")
  }
}

/**
 * Bug: "1 pipeline is running but the Watcher sidebar badge shows 0".
 * The badge (counts.watcher_runs) only checked domains.status membership;
 * a HEALTHY in-flight pipeline sits at a progress status (cf_assigned,
 * zone_created, …) that is NOT in the bucket, so the badge said 0 while
 * the watcher page correctly showed the run (it also keys off a running
 * step_tracker row). The count must mirror the page exactly.
 */
describe("status route — watcher_runs badge mirrors the watcher page", () => {
  it("counts a healthy in-flight pipeline whose status is a progress value (the bug)", async () => {
    await seedDomain("inflight.test", "cf_assigned", { running: true })
    expect(await watcherRuns()).toBe(1)
  })

  it("counts a stalled domain via status bucket even with no running step", async () => {
    await seedDomain("errored.test", "retryable_error")
    expect(await watcherRuns()).toBe(1)
  })

  it("still counts a dismissed domain while a worker is actively running it", async () => {
    await seedDomain("dismissed-active.test", "cf_assigned", { running: true, dismissed: true })
    expect(await watcherRuns()).toBe(1)
  })

  it("does NOT count a dismissed, idle, non-running domain", async () => {
    await seedDomain("dismissed-idle.test", "retryable_error", { dismissed: true })
    expect(await watcherRuns()).toBe(0)
  })

  it("does NOT count a healthy live domain with no running step", async () => {
    await seedDomain("live.test", "live")
    expect(await watcherRuns()).toBe(0)
  })

  it("sums the mixed fleet correctly", async () => {
    await seedDomain("inflight.test", "zone_created", { running: true })
    await seedDomain("errored.test", "terminal_error")
    await seedDomain("dismissed-active.test", "provisioned", { running: true, dismissed: true })
    await seedDomain("dismissed-idle.test", "canceled", { dismissed: true })
    await seedDomain("live.test", "live")
    expect(await watcherRuns()).toBe(3) // inflight + errored + dismissed-active
  })
})
