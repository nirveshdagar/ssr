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

describe("isPermanentLlmError (step 9 fast-fail classifier)", () => {
  it("flags HTTP 400/401/403 status mentions as permanent", async () => {
    const { isPermanentLlmError } = await import("@/lib/pipeline")
    // The shape providers in lib/website-generator.ts produce — they
    // embed the upstream HTTP status verbatim into the thrown Error msg.
    expect(isPermanentLlmError("anthropic HTTP 401: invalid api key")).toBe(true)
    expect(isPermanentLlmError("openai HTTP 403: missing model access")).toBe(true)
    expect(isPermanentLlmError("HTTP 400: bad request - max_tokens too high")).toBe(true)
  })

  it("flags credential / model wording as permanent even without an HTTP code", async () => {
    const { isPermanentLlmError } = await import("@/lib/pipeline")
    expect(isPermanentLlmError("No API key provided")).toBe(true)
    expect(isPermanentLlmError("Invalid api_key")).toBe(true)
    expect(isPermanentLlmError("authentication_error: bad key")).toBe(true)
    expect(isPermanentLlmError("Incorrect API key provided: sk-...")).toBe(true)
    expect(isPermanentLlmError("model_not_found: claude-foo-bar")).toBe(true)
    expect(isPermanentLlmError("unsupported model 'gpt-99'")).toBe(true)
    expect(isPermanentLlmError("permission_denied: org doesn't have access")).toBe(true)
  })

  it("does NOT flag transient errors — retry loop is exactly for these", async () => {
    const { isPermanentLlmError } = await import("@/lib/pipeline")
    // 429 rate-limit
    expect(isPermanentLlmError("anthropic HTTP 429: rate_limit_error")).toBe(false)
    // 5xx server
    expect(isPermanentLlmError("openai HTTP 502: bad gateway")).toBe(false)
    expect(isPermanentLlmError("HTTP 500: internal server error")).toBe(false)
    expect(isPermanentLlmError("HTTP 503: overloaded")).toBe(false)
    // Network / timeout
    expect(isPermanentLlmError("ECONNREFUSED 1.2.3.4:443")).toBe(false)
    expect(isPermanentLlmError("AbortError: signal aborted (timed out after 300s)")).toBe(false)
    expect(isPermanentLlmError("TimeoutError: operation timed out")).toBe(false)
    // Parse / shape problems — content recovers on retry
    expect(isPermanentLlmError("safeLlmJson: response was not valid JSON")).toBe(false)
    expect(isPermanentLlmError("parsed.php missing <!DOCTYPE>")).toBe(false)
    expect(isPermanentLlmError("")).toBe(false)
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
