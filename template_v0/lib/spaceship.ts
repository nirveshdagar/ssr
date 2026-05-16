/**
 * Spaceship registrar — Node port of modules/spaceship.py.
 *
 * Surface:
 *   - checkAvailability(domains)
 *   - purchaseDomain(domain, years?)         — async-op polled to completion
 *   - setNameservers(domain, hosts)          — array of NS hostnames
 *   - getDomainInfo(domain)
 *   - listDomains(take?, skip?)
 *   - deleteDomain(domain)                   — Spaceship returns 501 today
 *
 * Auth: X-API-Key + X-API-Secret from settings table (shared with Flask).
 *
 * NOTE: parallel Flask is also a target. Both apps read/write the same
 * data/ssr.db, and pipeline_log entries written here are visible to the
 * Flask UI immediately.
 */
import { getSetting, setSetting } from "./repos/settings"
import { logPipeline } from "./repos/logs"

const API_BASE = "https://spaceship.dev/api/v1"

function headers(): Record<string, string> {
  const apiKey = getSetting("spaceship_api_key")
  const apiSecret = getSetting("spaceship_api_secret")
  if (!apiKey || !apiSecret) {
    throw new Error("Spaceship API credentials not configured. Go to Settings.")
  }
  return {
    "X-API-Key": apiKey,
    "X-API-Secret": apiSecret,
    "Content-Type": "application/json",
    Accept: "application/json",
  }
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Wraps `fetch` with a default 30s timeout AND a 2-attempt linear-backoff
 * retry on 429 / 5xx / network errors. Spaceship has no idempotency-key
 * support and no failover-token concept, so a transient blip on the only
 * registrar would otherwise stall every step-1 / step-4 forever. Default
 * retries=2 picks up brief outages without amplifying load.
 *
 * Important: the caller still gets a single Response; callers that POST
 * non-idempotent operations (purchaseDomain) must check for "already in
 * account" themselves to avoid double-charge — see purchaseDomain.
 */
async function spaceshipFetch(
  url: string,
  init: RequestInit = {},
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const retries = opts.retries ?? 2
  const timeoutMs = opts.timeoutMs ?? 30_000
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
          continue
        }
      }
      return res
    } catch (e) {
      lastErr = e
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      throw e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("spaceshipFetch: exhausted retries")
}

function extractMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>
    const base = typeof o.message === "string" && o.message ? o.message : fallback
    // Spaceship 4xx validation bodies (e.g. 422 on purchase) carry the
    // useful field-level specifics in `errors`/`detail`, NOT `message`.
    // Append them instead of swallowing — opaque "HTTP 422" cost us a
    // round-trip during the 2026-05-16 buy investigation.
    const detail = o.errors ?? o.detail ?? o.data
    if (detail !== undefined) {
      let d: string
      try { d = JSON.stringify(detail) } catch { d = String(detail) }
      return `${base} — ${d}`.slice(0, 600)
    }
    return base
  }
  if (typeof body === "string" && body) return `${fallback}: ${body}`.slice(0, 600)
  return fallback
}

export interface AvailabilityResponse {
  domains: { name: string; isAvailable: boolean; isPremium?: boolean; price?: unknown }[]
}

export async function checkAvailability(
  domains: string | string[],
): Promise<AvailabilityResponse> {
  const list = Array.isArray(domains) ? domains : [domains]
  const res = await spaceshipFetch(`${API_BASE}/domains/available`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ domains: list }),
  })
  if (!res.ok) {
    const body = await safeJson(res)
    throw new Error(extractMessage(body, `HTTP ${res.status}`))
  }
  // Spaceship's live response is { domains: [{ domain, result: "available"
  // | "unavailable" | …, premiumPricing: [] }] }. The previously assumed
  // shape ({ name, isAvailable }) made Boolean(undefined) === false for
  // every domain, so the pipeline never bought and mislabeled domains as
  // "registered elsewhere". Normalize here; still accept the old shape.
  const raw = (await res.json()) as {
    domains?: { name?: string; domain?: string; isAvailable?: boolean; result?: string }[]
  }
  return {
    domains: (raw.domains ?? []).map((e) => ({
      name: e.name ?? e.domain ?? "",
      isAvailable: typeof e.result === "string"
        ? e.result.toLowerCase() === "available"
        : Boolean(e.isAvailable),
    })),
  }
}

async function pollAsyncOperation(
  operationId: string,
  timeoutMs = 120_000,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await spaceshipFetch(`${API_BASE}/async-operations/${operationId}`, {
      headers: headers(),
    })
    if (!res.ok) return { ok: false, error: `Operation poll HTTP ${res.status}` }
    const data = (await res.json()) as { status?: string; error?: string }
    if (data.status === "success") return { ok: true, data }
    if (data.status === "failed") return { ok: false, error: data.error || "Operation failed" }
    await new Promise((r) => setTimeout(r, 5000))
  }
  return { ok: false, error: "Operation timed out" }
}

/**
 * Spaceship wants phone as dotted E.164: "+<cc>.<subscriber>". Operators
 * usually store it human-formatted ("+1 3073180850"); convert the first
 * separator run to a dot and strip the rest. Already-dotted values pass
 * through unchanged. If it's too mangled to parse we send it as-is and let
 * Spaceship's (now surfaced) 422 say so rather than silently corrupt it.
 */
function normalizePhone(raw: string): string {
  const t = raw.trim()
  if (/^\+\d+\.\d+$/.test(t)) return t
  return t.replace(/\s+/, ".").replace(/[\s()-]/g, "")
}

/**
 * Flat contact body Spaceship's `PUT /api/v1/contacts` expects (discovered
 * 2026-05-16 — POST 404s, nested `address` 422s; it returns
 * `{ contactId }`). Defaults keep a never-empty body for unconfigured
 * fields, but a real registration needs valid registrant_* settings.
 */
function buildContactBody(): Record<string, string> {
  return {
    firstName: getSetting("registrant_first_name") || "Domain",
    lastName: getSetting("registrant_last_name") || "Admin",
    email: getSetting("registrant_email") || "",
    phone: normalizePhone(getSetting("registrant_phone") || "+1.0000000000"),
    address1: getSetting("registrant_address") || "123 Main St",
    city: getSetting("registrant_city") || "New York",
    stateProvince: getSetting("registrant_state") || "NY",
    postalCode: getSetting("registrant_zip") || "10001",
    country: getSetting("registrant_country") || "US",
  }
}

/**
 * Spaceship's domain-register endpoint takes contact *ID strings*, not
 * inline contact objects (that was the HTTP 422 on every buy). Create one
 * contact and cache its id in settings so we don't mint a new contact on
 * every purchase.
 */
async function ensureContactId(): Promise<string> {
  const cached = getSetting("spaceship_contact_id")
  if (cached) return cached
  const res = await spaceshipFetch(`${API_BASE}/contacts`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(buildContactBody()),
  }, { retries: 0 })
  if (!res.ok) {
    const body = await safeJson(res)
    throw new Error(`contact create failed: ${extractMessage(body, `HTTP ${res.status}`)}`)
  }
  const data = (await res.json()) as { contactId?: string }
  if (!data.contactId) throw new Error("contact create returned no contactId")
  setSetting("spaceship_contact_id", data.contactId)
  return data.contactId
}

export async function purchaseDomain(
  domain: string,
  years = 1,
): Promise<{ ok: boolean; result: unknown }> {
  logPipeline(domain, "domain_purchase", "running", `Purchasing ${domain} for ${years} year(s)`)
  try {
    // Pre-purchase idempotency check — if a previous purchase succeeded but
    // we lost the response (network blip, our timeout fired after Spaceship
    // already charged), the domain is already in the account and a second
    // POST would double-charge. Spaceship returns 200 from getDomainInfo for
    // owned domains and 4xx otherwise, so we use it as the existence probe.
    try {
      await getDomainInfo(domain)
      logPipeline(domain, "domain_purchase", "warning",
        `${domain} already in Spaceship account; skipping POST to avoid double-charge`)
      return { ok: true, result: { idempotent: true } }
    } catch { /* not in account — proceed to purchase */ }

    const contactId = await ensureContactId()
    const payload = {
      autoRenew: false,
      years,
      privacyProtection: { level: "high", userConsent: true },
      contacts: {
        registrant: contactId, admin: contactId, tech: contactId, billing: contactId,
      },
    }
    // Don't retry POST /domains automatically — every retry is a new
    // purchase attempt and the side effect is a real charge. The pre-check
    // above handles the lost-response case for the previous purchase; let
    // any failure here surface to the caller.
    const res = await spaceshipFetch(`${API_BASE}/domains/${domain}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
    }, { retries: 0 })
    if (res.status === 202) {
      const opId = res.headers.get("spaceship-async-operationid") || ""
      if (opId) {
        logPipeline(domain, "domain_purchase", "running", `Async operation ${opId} — polling...`)
        const result = await pollAsyncOperation(opId)
        if (result.ok) {
          logPipeline(domain, "domain_purchase", "completed", `Domain purchased: ${domain}`)
          return { ok: true, result: result.data }
        }
        logPipeline(domain, "domain_purchase", "failed", result.error)
        return { ok: false, result: result.error }
      }
      logPipeline(domain, "domain_purchase", "completed", `Domain purchased: ${domain}`)
      return { ok: true, result: (await safeJson(res)) ?? {} }
    }
    if (!res.ok) {
      const body = await safeJson(res)
      const msg = extractMessage(body, `HTTP ${res.status}`)
      logPipeline(domain, "domain_purchase", "failed", msg)
      return { ok: false, result: msg }
    }
    logPipeline(domain, "domain_purchase", "completed", `Domain purchased: ${domain}`)
    return { ok: true, result: await res.json() }
  } catch (e) {
    const msg = (e as Error).message
    logPipeline(domain, "domain_purchase", "failed", msg)
    return { ok: false, result: msg }
  }
}

export async function setNameservers(domain: string, nameservers: string[]): Promise<boolean> {
  logPipeline(domain, "set_nameservers", "running", `Setting NS: ${nameservers.join(", ")}`)
  try {
    const res = await spaceshipFetch(`${API_BASE}/domains/${domain}/nameservers`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ provider: "custom", hosts: nameservers }),
    })
    if (!res.ok) {
      const body = await safeJson(res)
      const msg = extractMessage(body, `HTTP ${res.status}`)
      logPipeline(domain, "set_nameservers", "failed", msg)
      return false
    }
    logPipeline(domain, "set_nameservers", "completed", `NS set to ${nameservers.join(", ")}`)
    return true
  } catch (e) {
    logPipeline(domain, "set_nameservers", "failed", (e as Error).message)
    return false
  }
}

/**
 * Switch the domain's nameservers back to Spaceship's basic/default pool.
 * Used by full-delete teardown so the registrar isn't left pointing at a
 * Cloudflare zone we're about to delete.
 *
 * Returns:
 *   { ok: true }                — basic NS restored
 *   { ok: false, notOurs: true} — Spaceship returned 404 (domain isn't on
 *                                 this Spaceship account; BYO at another
 *                                 registrar — operator must reset NS by hand)
 *   { ok: false, error }        — any other failure (network, auth, etc.)
 */
export async function restoreDefaultNameservers(
  domain: string,
): Promise<{ ok: boolean; notOurs?: boolean; error?: string }> {
  logPipeline(domain, "restore_nameservers", "running",
    "Switching domain back to Spaceship's basic NS pool before CF zone delete")
  try {
    const res = await spaceshipFetch(`${API_BASE}/domains/${domain}/nameservers`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ provider: "basic" }),
    })
    if (res.status === 404) {
      logPipeline(domain, "restore_nameservers", "warning",
        "Spaceship returned 404 — domain isn't on this account (BYO at another registrar). " +
        "Operator must reset NS at the original registrar by hand.")
      return { ok: false, notOurs: true }
    }
    if (!res.ok) {
      const body = await safeJson(res)
      const msg = extractMessage(body, `HTTP ${res.status}`)
      logPipeline(domain, "restore_nameservers", "failed", msg)
      return { ok: false, error: msg }
    }
    logPipeline(domain, "restore_nameservers", "completed",
      "Domain switched to Spaceship basic NS — registrar will resolve cleanly after CF zone delete")
    return { ok: true }
  } catch (e) {
    const msg = (e as Error).message
    logPipeline(domain, "restore_nameservers", "failed", msg)
    return { ok: false, error: msg }
  }
}

export async function getDomainInfo(domain: string): Promise<unknown> {
  const res = await spaceshipFetch(`${API_BASE}/domains/${domain}`, { headers: headers() })
  if (!res.ok) throw new Error(`Spaceship get_domain HTTP ${res.status}`)
  return res.json()
}

export async function listDomains(take = 25, skip = 0): Promise<unknown> {
  const url = `${API_BASE}/domains?take=${take}&skip=${skip}`
  const res = await spaceshipFetch(url, { headers: headers() })
  if (!res.ok) throw new Error(`Spaceship list_domains HTTP ${res.status}`)
  return res.json()
}

export async function deleteDomain(domain: string): Promise<{ ok: boolean; message: string }> {
  logPipeline(domain, "spaceship_delete", "running", `Attempting to delete ${domain} from Spaceship...`)
  try {
    const res = await spaceshipFetch(`${API_BASE}/domains/${domain}`, {
      method: "DELETE",
      headers: headers(),
    })
    if (res.status === 501) {
      const msg = "Spaceship API does not support domain deletion. Delete manually from dashboard."
      logPipeline(domain, "spaceship_delete", "warning", msg)
      return { ok: false, message: msg }
    }
    if (!res.ok) {
      const body = await safeJson(res)
      const msg = extractMessage(body, `HTTP ${res.status}`)
      logPipeline(domain, "spaceship_delete", "failed", msg)
      return { ok: false, message: msg }
    }
    logPipeline(domain, "spaceship_delete", "completed", `${domain} deleted from Spaceship`)
    return { ok: true, message: "Deleted" }
  } catch (e) {
    const msg = (e as Error).message
    logPipeline(domain, "spaceship_delete", "failed", msg)
    return { ok: false, message: msg }
  }
}
