import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM jobs")
  run("DELETE FROM domains")
  // Reset in-process slot lock
  ;(globalThis as Record<string, unknown>).__ssrInflightDomains = new Set()
})

describe("pipeline slot lock", () => {
  it("isPipelineRunning returns false initially", async () => {
    const { isPipelineRunning } = await import("@/lib/pipeline")
    expect(isPipelineRunning("test.example.com")).toBe(false)
  })

  it("runFullPipeline rejects a second concurrent run for the same domain", async () => {
    const { runFullPipeline, isPipelineRunning } = await import("@/lib/pipeline")
    const id1 = runFullPipeline("dup.example.com")
    expect(id1).toBeGreaterThan(0)
    expect(isPipelineRunning("dup.example.com")).toBe(true)
    const id2 = runFullPipeline("dup.example.com")
    expect(id2).toBeNull()
  })

  it("runBulkPipeline enqueues one pipeline.full job per eligible domain (fan-out)", async () => {
    const { runFullPipeline, runBulkPipeline } = await import("@/lib/pipeline")
    runFullPipeline("busy.example.com")
    // Bulk enqueue [busy, fresh, also-fresh] — busy is skipped, the other two
    // each get their own pipeline.full job so the worker pool can fan out.
    const result = runBulkPipeline([
      "busy.example.com", "fresh.example.com", "also-fresh.example.com",
    ])
    expect(result.enqueued).toBe(2)
    expect(result.skipped).toBe(1)
    expect(result.job_ids.length).toBe(2)

    const { listJobs } = await import("@/lib/jobs")
    const fullJobs = listJobs({ kind: "pipeline.full", limit: 5 })
      .filter((j) => result.job_ids.includes(j.id))
    expect(fullJobs.length).toBe(2)
    const enqueuedDomains = fullJobs
      .map((j) => (JSON.parse(j.payload_json) as { domain: string }).domain)
      .sort()
    expect(enqueuedDomains).toEqual(["also-fresh.example.com", "fresh.example.com"])
  })

  it("runBulkPipeline returns enqueued=0 when every domain is busy", async () => {
    const { runFullPipeline, runBulkPipeline } = await import("@/lib/pipeline")
    runFullPipeline("a.example.com")
    runFullPipeline("b.example.com")
    const result = runBulkPipeline(["a.example.com", "b.example.com"])
    expect(result.enqueued).toBe(0)
    expect(result.skipped).toBe(2)
    expect(result.job_id).toBeNull()
    expect(result.job_ids).toEqual([])
  })
})

describe("pipeline handlers register without conflict", () => {
  it("registerPipelineHandlers does not throw on first call", async () => {
    const { registerPipelineHandlers } = await import("@/lib/pipeline")
    expect(() => registerPipelineHandlers()).not.toThrow()
  })

  it("re-registering the same handler is idempotent (HMR-safe)", async () => {
    // We intentionally moved off "throw on dupe" to "replace silently" so
    // Next dev mode's HMR — which re-evaluates instrumentation on every
    // edit — doesn't spam the console with handler-already-registered
    // errors. The new contract: re-register is a no-op replace.
    const { registerPipelineHandlers } = await import("@/lib/pipeline")
    expect(() => registerPipelineHandlers()).not.toThrow()
    expect(() => registerPipelineHandlers()).not.toThrow()
  })
})
