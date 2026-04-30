/**
 * Resolve the client IP from a request. Centralizes the X-Forwarded-For
 * trust decision so we never sprinkle `req.headers.get("x-forwarded-for")`
 * around the codebase.
 *
 * Behavior:
 *   - SSR_TRUST_PROXY=1 → trust the leftmost XFF entry (set this only when
 *     deployed behind a proxy that strips client-supplied XFF headers and
 *     appends the real peer)
 *   - otherwise          → ignore XFF entirely, return null (downstream code
 *     uses null as "unknown IP" — login throttle keys on "?" instead)
 *
 * Why: XFF is client-supplied unless a trusted proxy in front rewrites it.
 * A naïve `xff.split(",")[0]` lets an attacker rotate IPs with `XFF: 1.2.3.4,
 * 1.2.3.5, …` to defeat per-IP rate limits + forge audit-log actor entries.
 */

export function clientIp(req: { headers: { get: (k: string) => string | null } }): string | null {
  if (process.env.SSR_TRUST_PROXY === "1") {
    const xff = req.headers.get("x-forwarded-for")
    if (xff) {
      const first = xff.split(",")[0]?.trim()
      if (first) return first
    }
  }
  // Fall back to RealIP / CF-Connecting-IP if a known-good proxy chain is
  // setting one of those AND we're trusting the proxy. (Most operators run
  // behind nginx/cloudflare.)
  if (process.env.SSR_TRUST_PROXY === "1") {
    const real = req.headers.get("x-real-ip")
    if (real) return real.trim()
    const cf = req.headers.get("cf-connecting-ip")
    if (cf) return cf.trim()
  }
  // No safe IP source. Throttling keys on "?" — bounded but not per-IP.
  return null
}
