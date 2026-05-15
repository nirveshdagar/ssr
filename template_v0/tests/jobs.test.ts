import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

describe("jobs queue", () => {
  it("enqueueJob inserts a row in 'queued' state", async () => {
    const { enqueueJob, getJob } = await import("@/lib/jobs")
    const id = enqueueJob("test.kind", { x: 1 })
    const row = getJob(id)
    expect(row?.status).toBe("queued")
    expect(row?.kind).toBe("test.kind")
    expect(JSON.parse(row!.payload_json)).toEqual({ x: 1 })
    expect(row?.attempt_count).toBe(0)
  })

  it("recoverOrphans requeues 'running' rows under attempt cap, fails ones at cap", async () => {
    const { all, run } = await import("@/lib/db")
    const { recoverOrphans } = await import("@/lib/jobs")
    const now = Date.now() / 1000
    // Insert one running-but-recoverable + one running-and-exhausted
    run(
      `INSERT INTO jobs(kind, payload_json, status, attempt_count, max_attempts, locked_by, locked_at, created_at, updated_at)
       VALUES('orphan.fresh', '{}', 'running', 1, 3, 'dead-worker', ?, ?, ?)`,
      now, now, now,
    )
    run(
      `INSERT INTO jobs(kind, payload_json, status, attempt_count, max_attempts, locked_by, locked_at, created_at, updated_at)
       VALUES('orphan.exhausted', '{}', 'running', 3, 3, 'dead-worker', ?, ?, ?)`,
      now, now, now,
    )
    const changed = recoverOrphans()
    expect(changed).toBeGreaterThanOrEqual(2)
    const rows = all<{ kind: string; status: string }>(
      "SELECT kind, status FROM jobs WHERE kind LIKE 'orphan.%'",
    )
    const fresh = rows.find((r) => r.kind === "orphan.fresh")
    const exhausted = rows.find((r) => r.kind === "orphan.exhausted")
    expect(fresh?.status).toBe("queued")
    expect(exhausted?.status).toBe("failed")
  })

  it("listJobs filters by kind + status", async () => {
    const { enqueueJob, listJobs } = await import("@/lib/jobs")
    enqueueJob("filter.a", {})
    enqueueJob("filter.b", {})
    const a = listJobs({ kind: "filter.a", status: "queued" })
    expect(a.length).toBe(1)
    expect(a[0].kind).toBe("filter.a")
  })
})
