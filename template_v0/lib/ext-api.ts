/**
 * Fail-loud guards for external-API responses.
 *
 * Every Spaceship/CF/SA/DO bug this session was the same shape: a
 * `(await res.json()) as SomeInterface` cast where the provider had
 * changed the shape, so field access silently yielded `undefined` and the
 * code coerced it into wrong behavior (Boolean(undefined) === false →
 * "every domain unavailable", opaque "HTTP 422", etc.) instead of failing.
 *
 * `requireShape` makes the boundary explicit: when the response is
 * structurally unrecognizable, throw a specific error carrying a redacted
 * snippet of the raw body — loud and diagnosable — instead of coercing.
 *
 * IMPORTANT: the `ok` predicate must check only that the response is
 * *structurally* what we need (e.g. "has a `domains` array"), NOT that it
 * is non-empty or "positive". A valid empty / negative result must still
 * pass — the goal is to catch drift, not to reject benign variance.
 */
export class ExternalApiShapeError extends Error {
  constructor(public provider: string, public snippet: string) {
    super(`${provider}: unexpected API response shape — ${snippet}`)
    this.name = "ExternalApiShapeError"
  }
}

/** Stringify + truncate a raw body for logs, redacting secret-ish values. */
export function snippetOf(raw: unknown, max = 300): string {
  let s: string
  try {
    s = typeof raw === "string" ? raw : JSON.stringify(raw)
  } catch {
    s = String(raw)
  }
  if (s == null) s = String(raw)
  // Redact values of keys that look like secrets before logging.
  s = s.replace(
    /("[^"]*(?:key|secret|token|password|api[_-]?key)[^"]*"\s*:\s*)"[^"]*"/gi,
    '$1"***"',
  )
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * Return `raw` typed as `T` if `ok(raw)` holds; otherwise throw
 * `ExternalApiShapeError` with a redacted snippet.
 */
export function requireShape<T>(
  provider: string,
  raw: unknown,
  ok: (v: unknown) => boolean,
): T {
  if (!ok(raw)) throw new ExternalApiShapeError(provider, snippetOf(raw))
  return raw as T
}
