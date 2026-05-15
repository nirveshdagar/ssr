/**
 * Per-IP login throttle — Node port of app.py's _login_throttle_check /
 * _login_throttle_record. Holds an in-memory map of IP → recent failed
 * timestamps. Successful login clears the IP's bucket. Anonymous (no IP
 * header) shares one bucket so a misconfigured proxy still gets rate-limited.
 *
 * State is per-process. Survives across requests via globalThis cache so
 * dev-server HMR reloads don't reset the throttle counters.
 */

const MAX_PER_WINDOW = 5
const WINDOW_SECONDS = 60

declare global {
  // eslint-disable-next-line no-var
  var __ssrLoginAttempts: Map<string, number[]> | undefined
}

function attempts(): Map<string, number[]> {
  if (!globalThis.__ssrLoginAttempts) globalThis.__ssrLoginAttempts = new Map()
  return globalThis.__ssrLoginAttempts
}

/** True if the IP is allowed to try again. False = throttle, return 429.
 *  Pure read; does NOT mutate the bucket. Use `loginThrottleCheckAndReserve`
 *  in the actual route to close the parallel-request race. */
export function loginThrottleCheck(ip: string | null): boolean {
  const key = ip || "?"
  const now = Date.now() / 1000
  const m = attempts()
  const recent = (m.get(key) ?? []).filter((t) => now - t < WINDOW_SECONDS)
  m.set(key, recent)
  return recent.length < MAX_PER_WINDOW
}

/**
 * Atomic check + reserve. Returns true if the attempt is allowed AND
 * pre-records it as a (provisionally failed) attempt; returns false if
 * the bucket is full. Single synchronous pass — N parallel requests
 * cannot all read length<5 and proceed: the (N+1)th sees the bucket
 * filled by the prior N. On successful auth the caller clears the
 * bucket via `loginThrottleRecord(ip, true)`.
 */
export function loginThrottleCheckAndReserve(ip: string | null): boolean {
  const key = ip || "?"
  const now = Date.now() / 1000
  const m = attempts()
  const recent = (m.get(key) ?? []).filter((t) => now - t < WINDOW_SECONDS)
  if (recent.length >= MAX_PER_WINDOW) {
    m.set(key, recent)
    return false
  }
  recent.push(now)
  m.set(key, recent)
  return true
}

export function loginThrottleRecord(ip: string | null, ok: boolean): void {
  const key = ip || "?"
  const m = attempts()
  if (ok) {
    m.delete(key)
  } else {
    const arr = m.get(key) ?? []
    arr.push(Date.now() / 1000)
    m.set(key, arr)
  }
}

/** How many seconds until the IP can try again. 0 if not throttled. */
export function loginThrottleRetryAfter(ip: string | null): number {
  const key = ip || "?"
  const now = Date.now() / 1000
  const arr = (attempts().get(key) ?? []).filter((t) => now - t < WINDOW_SECONDS)
  if (arr.length < MAX_PER_WINDOW) return 0
  // Wait until the oldest attempt falls out of the window
  return Math.max(1, Math.ceil(WINDOW_SECONDS - (now - arr[0])))
}

/** For tests — drop the in-memory state. */
export function _resetThrottle(): void {
  delete (globalThis as Record<string, unknown>).__ssrLoginAttempts
}
