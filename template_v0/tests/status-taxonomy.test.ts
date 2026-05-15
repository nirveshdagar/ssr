import { describe, expect, it } from "vitest"
import {
  isRetryableError, isTerminalError, isErrorStatus, isWaitingStatus,
  isReadyStatus, isSuccessStatus,
  RETRYABLE_ERROR_STATUSES, TERMINAL_ERROR_STATUSES,
  WAITING_STATUSES, READY_STATUSES, SUCCESS_STATUSES,
  PIPELINE_STEPS,
} from "@/lib/status-taxonomy"

describe("status-taxonomy", () => {
  it("retryable errors classify correctly", () => {
    expect(isRetryableError("retryable_error")).toBe(true)
    expect(isRetryableError("error")).toBe(true)
    expect(isRetryableError("terminal_error")).toBe(false)
    expect(isRetryableError(null)).toBe(false)
    expect(isRetryableError(undefined)).toBe(false)
  })

  it("terminal errors classify correctly", () => {
    expect(isTerminalError("terminal_error")).toBe(true)
    expect(isTerminalError("cf_pool_full")).toBe(true)
    expect(isTerminalError("content_blocked")).toBe(true)
    expect(isTerminalError("purchase_failed")).toBe(true)
    expect(isTerminalError("retryable_error")).toBe(false)
    expect(isTerminalError("hosted")).toBe(false)
  })

  it("isErrorStatus is the union of retryable + terminal", () => {
    for (const s of [...RETRYABLE_ERROR_STATUSES, ...TERMINAL_ERROR_STATUSES]) {
      expect(isErrorStatus(s)).toBe(true)
    }
    expect(isErrorStatus("hosted")).toBe(false)
    expect(isErrorStatus("waiting_dns")).toBe(false)
  })

  it("waiting + ready + success sets are disjoint from each other", () => {
    for (const s of WAITING_STATUSES) {
      expect(READY_STATUSES.has(s)).toBe(false)
      expect(SUCCESS_STATUSES.has(s)).toBe(false)
    }
    for (const s of SUCCESS_STATUSES) {
      expect(WAITING_STATUSES.has(s)).toBe(false)
    }
  })

  it("isWaitingStatus + isReadyStatus + isSuccessStatus", () => {
    expect(isWaitingStatus("ns_pending_external")).toBe(true)
    expect(isReadyStatus("zone_active")).toBe(true)
    expect(isSuccessStatus("hosted")).toBe(true)
    expect(isSuccessStatus("live")).toBe(true)
    expect(isSuccessStatus("ssl_installed")).toBe(true)
    expect(isSuccessStatus("retryable_error")).toBe(false)
  })

  it("PIPELINE_STEPS has 10 entries with sensible names", () => {
    const keys = Object.keys(PIPELINE_STEPS).map(Number).sort((a, b) => a - b)
    expect(keys).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(PIPELINE_STEPS[1]).toMatch(/Buy/)
    expect(PIPELINE_STEPS[10]).toMatch(/Upload/)
  })
})
