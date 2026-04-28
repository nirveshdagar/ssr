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
import { getSetting } from "./repos/settings"
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

function extractMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as { message?: unknown }).message
    if (typeof m === "string" && m) return m
  }
  return fallback
}

export interface AvailabilityResponse {
  domains: { name: string; isAvailable: boolean; isPremium?: boolean; price?: unknown }[]
}

export async function checkAvailability(
  domains: string | string[],
): Promise<AvailabilityResponse> {
  const list = Array.isArray(domains) ? domains : [domains]
  const res = await fetch(`${API_BASE}/domains/available`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ domains: list }),
  })
  if (!res.ok) {
    const body = await safeJson(res)
    throw new Error(extractMessage(body, `HTTP ${res.status}`))
  }
  return (await res.json()) as AvailabilityResponse
}

async function pollAsyncOperation(
  operationId: string,
  timeoutMs = 120_000,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${API_BASE}/async-operations/${operationId}`, {
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

interface ContactInfo {
  firstName: string
  lastName: string
  email: string
  phone: string
  address: {
    line1: string
    city: string
    state: string
    zip: string
    country: string
  }
}

function buildContacts(): { registrant: ContactInfo; admin: ContactInfo; tech: ContactInfo; billing: ContactInfo } {
  const registrant: ContactInfo = {
    firstName: getSetting("registrant_first_name") || "Domain",
    lastName: getSetting("registrant_last_name") || "Admin",
    email: getSetting("registrant_email") || "",
    phone: getSetting("registrant_phone") || "+1.0000000000",
    address: {
      line1: getSetting("registrant_address") || "123 Main St",
      city: getSetting("registrant_city") || "New York",
      state: getSetting("registrant_state") || "NY",
      zip: getSetting("registrant_zip") || "10001",
      country: getSetting("registrant_country") || "US",
    },
  }
  return { registrant, admin: registrant, tech: registrant, billing: registrant }
}

export async function purchaseDomain(
  domain: string,
  years = 1,
): Promise<{ ok: boolean; result: unknown }> {
  logPipeline(domain, "domain_purchase", "running", `Purchasing ${domain} for ${years} year(s)`)
  try {
    const payload = {
      autoRenew: false,
      years,
      privacyProtection: { level: "high" },
      contacts: buildContacts(),
    }
    const res = await fetch(`${API_BASE}/domains/${domain}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
    })
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
    const res = await fetch(`${API_BASE}/domains/${domain}/nameservers`, {
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
    const res = await fetch(`${API_BASE}/domains/${domain}/nameservers`, {
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
  const res = await fetch(`${API_BASE}/domains/${domain}`, { headers: headers() })
  if (!res.ok) throw new Error(`Spaceship get_domain HTTP ${res.status}`)
  return res.json()
}

export async function listDomains(take = 25, skip = 0): Promise<unknown> {
  const url = `${API_BASE}/domains?take=${take}&skip=${skip}`
  const res = await fetch(url, { headers: headers() })
  if (!res.ok) throw new Error(`Spaceship list_domains HTTP ${res.status}`)
  return res.json()
}

export async function deleteDomain(domain: string): Promise<{ ok: boolean; message: string }> {
  logPipeline(domain, "spaceship_delete", "running", `Attempting to delete ${domain} from Spaceship...`)
  try {
    const res = await fetch(`${API_BASE}/domains/${domain}`, {
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
