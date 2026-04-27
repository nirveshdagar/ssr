/**
 * Cloudflare REST client — Node port of modules/cloudflare_api.py.
 * Uses the per-domain credentials stored on the domains row (cf_email +
 * cf_global_key) as the X-Auth headers, mirroring the Flask side.
 *
 * Surface:
 *   bulk / dashboard:
 *     - getZoneId, getDnsRecords, upsertDnsRecord
 *     - setDnsARecord, setDnsARecordWww
 *     - getZoneSetting, setZoneSetting, setSslMode, setAlwaysUseHttps
 *   pipeline:
 *     - getZoneDetails, getNameservers, getZoneStatus
 *     - createZoneForDomain   (with self-heal on stale account_id)
 *     - deleteZone
 *     - fetchOriginCaCert     (RSA-2048 keypair + CSR generated locally
 *                              via node-forge, signed by CF Origin CA)
 */

const CF_API = "https://api.cloudflare.com/client/v4"

export const VALID_SSL_MODES = ["off", "flexible", "full", "strict"] as const
export type SslMode = (typeof VALID_SSL_MODES)[number]
export const VALID_DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT"] as const
export type DnsRecordType = (typeof VALID_DNS_RECORD_TYPES)[number]

import { one } from "./db"

interface DomainCreds {
  cf_email: string
  cf_global_key: string
}

function loadCreds(domain: string): DomainCreds {
  const row = one<{ cf_email: string | null; cf_global_key: string | null }>(
    "SELECT cf_email, cf_global_key FROM domains WHERE domain = ?",
    domain,
  )
  if (!row || !row.cf_email || !row.cf_global_key) {
    throw new Error(
      `${domain}: cf_email / cf_global_key missing — run cf_key_pool.assign_cf_key_to_domain(domain) first (Flask side for now)`,
    )
  }
  return { cf_email: row.cf_email, cf_global_key: row.cf_global_key }
}

function authHeaders(creds: DomainCreds, json = true): Record<string, string> {
  return {
    "X-Auth-Email": creds.cf_email,
    "X-Auth-Key": creds.cf_global_key,
    ...(json ? { "Content-Type": "application/json" } : {}),
  }
}

interface CfResponse<T> {
  success: boolean
  errors?: { code: number; message: string }[]
  result: T
}

async function cfRequest<T>(
  method: string,
  url: string,
  creds: DomainCreds,
  body?: unknown,
  retries = 3,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: authHeaders(creds, body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      if (res.status === 429 || res.status >= 500) {
        // Retry on rate-limit / 5xx with linear backoff
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      const json = (await res.json()) as CfResponse<T>
      if (!res.ok || !json.success) {
        const msg = json.errors?.map((e) => `${e.code}:${e.message}`).join("; ") ?? `HTTP ${res.status}`
        throw new Error(`CF ${method} ${url}: ${msg}`)
      }
      return json.result
    } catch (e) {
      lastErr = e
      if (attempt === retries - 1) throw e
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
  throw lastErr
}

const ZONE_CACHE = new Map<string, string>()

export async function getZoneId(domain: string): Promise<string> {
  const cached = ZONE_CACHE.get(domain)
  if (cached) return cached
  const creds = loadCreds(domain)
  const result = await cfRequest<{ id: string; name: string }[]>(
    "GET",
    `${CF_API}/zones?name=${encodeURIComponent(domain)}`,
    creds,
  )
  if (!result.length) throw new Error(`No CF zone for ${domain}`)
  const zoneId = result[0].id
  ZONE_CACHE.set(domain, zoneId)
  return zoneId
}

interface DnsRecord {
  id: string
  type: string
  name: string
  content: string
  proxied?: boolean
  ttl: number
}

export async function getDnsRecords(
  domain: string,
  type: DnsRecordType | string,
  name?: string,
): Promise<DnsRecord[]> {
  const creds = loadCreds(domain)
  const zoneId = await getZoneId(domain)
  const params = new URLSearchParams({ type })
  if (name) params.set("name", name)
  return cfRequest<DnsRecord[]>(
    "GET",
    `${CF_API}/zones/${zoneId}/dns_records?${params}`,
    creds,
  )
}

export async function upsertDnsRecord(opts: {
  domain: string
  type: DnsRecordType | string
  name: string
  content: string
  proxied?: boolean
  ttl?: number
}): Promise<string> {
  const recordType = (opts.type || "").toUpperCase() as DnsRecordType
  if (!VALID_DNS_RECORD_TYPES.includes(recordType as DnsRecordType)) {
    throw new Error(`record_type must be one of ${VALID_DNS_RECORD_TYPES.join(", ")}; got ${opts.type}`)
  }
  const creds = loadCreds(opts.domain)
  const zoneId = await getZoneId(opts.domain)

  const trimmedName = (opts.name || "").trim()
  let fullName: string
  if (!trimmedName || trimmedName === "@" || trimmedName === opts.domain) {
    fullName = opts.domain
  } else if (trimmedName === opts.domain || trimmedName.endsWith("." + opts.domain)) {
    fullName = trimmedName
  } else {
    fullName = `${trimmedName}.${opts.domain}`
  }

  const body: Record<string, unknown> = {
    type: recordType,
    name: fullName,
    content: opts.content,
    ttl: Math.floor(opts.ttl ?? 1) || 1,
  }
  if (recordType === "A" || recordType === "AAAA" || recordType === "CNAME") {
    body.proxied = Boolean(opts.proxied)
  }

  const existing = await cfRequest<DnsRecord[]>(
    "GET",
    `${CF_API}/zones/${zoneId}/dns_records?type=${recordType}&name=${encodeURIComponent(fullName)}`,
    creds,
  )
  if (existing.length > 0) {
    const r = await cfRequest<DnsRecord>(
      "PUT",
      `${CF_API}/zones/${zoneId}/dns_records/${existing[0].id}`,
      creds,
      body,
    )
    return r.id
  } else {
    const r = await cfRequest<DnsRecord>(
      "POST",
      `${CF_API}/zones/${zoneId}/dns_records`,
      creds,
      body,
    )
    return r.id
  }
}

export async function setDnsARecord(
  domain: string,
  ip: string,
  proxied = true,
): Promise<void> {
  await upsertDnsRecord({ domain, type: "A", name: "@", content: ip, proxied, ttl: 1 })
}

export async function setDnsARecordWww(
  domain: string,
  ip: string,
  proxied = true,
): Promise<void> {
  await upsertDnsRecord({ domain, type: "A", name: "www", content: ip, proxied, ttl: 1 })
}

export async function getZoneSetting(domain: string, settingId: string): Promise<unknown> {
  const creds = loadCreds(domain)
  const zoneId = await getZoneId(domain)
  const result = await cfRequest<{ value: unknown }>(
    "GET",
    `${CF_API}/zones/${zoneId}/settings/${settingId}`,
    creds,
  )
  return result?.value
}

export async function setZoneSetting(
  domain: string,
  settingId: string,
  value: unknown,
): Promise<unknown> {
  const creds = loadCreds(domain)
  const zoneId = await getZoneId(domain)
  const result = await cfRequest<{ value: unknown }>(
    "PATCH",
    `${CF_API}/zones/${zoneId}/settings/${settingId}`,
    creds,
    { value },
  )
  return result?.value
}

export async function setSslMode(domain: string, mode: SslMode): Promise<void> {
  if (!VALID_SSL_MODES.includes(mode)) {
    throw new Error(`ssl mode must be one of ${VALID_SSL_MODES.join(", ")}; got ${mode}`)
  }
  await setZoneSetting(domain, "ssl", mode)
}

export async function setAlwaysUseHttps(domain: string, enabled: boolean): Promise<void> {
  await setZoneSetting(domain, "always_use_https", enabled ? "on" : "off")
}

/** Initial DNS setup: apex+www A records (proxied) + SSL=full + always-https. */
export async function setupDomainDns(domain: string, ip: string): Promise<boolean> {
  try {
    await setDnsARecord(domain, ip, true)
    await setDnsARecordWww(domain, ip, true)
    await setSslMode(domain, "full")
    await setAlwaysUseHttps(domain, true)
    return true
  } catch (e) {
    // logPipeline below requires the import added later in the file; do it
    // lazily so this helper can be called even without a request context.
    try {
      const { logPipeline } = await import("./repos/logs")
      logPipeline(domain, "dns_setup", "failed", (e as Error).message)
    } catch { /* ignore */ }
    return false
  }
}

// ============================================================================
//  Pipeline surface — zone create / status / delete + Origin CA issuance
// ============================================================================
//
// These functions assume the domain already has cf_email, cf_global_key, and
// cf_account_id populated on its row (done by cf_key_pool.assignCfKeyToDomain).
// They DO NOT touch the bulk surface above — they're additive.

import forge from "node-forge"
import { getDomain, updateDomain } from "./repos/domains"
import { logPipeline } from "./repos/logs"
import { refreshCfAccountId } from "./cf-key-pool"

/** CF's public Origin CA RSA Root — embedded so the SSL chain we install on
 *  the origin server is self-contained (no extra fetch). Identical bytes to
 *  the Python `CF_ORIGIN_CA_RSA_ROOT_PEM` constant. */
export const CF_ORIGIN_CA_RSA_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIIFBjCCAu6gAwIBAgIRAIp9PhPWLzDvI4a9KQdrNPgwDQYJKoZIhvcNAQELBQAw
gYIxCzAJBgNVBAYTAlVTMRkwFwYDVQQKExBDbG91ZEZsYXJlLCBJbmMuMR0wGwYD
VQQLExRDbG91ZEZsYXJlIE9yaWdpbiBDQTE5MDcGA1UEAxMwQ2xvdWRGbGFyZSBP
cmlnaW4gUlNBIENlcnRpZmljYXRlIEF1dGhvcml0eTAeFw0yMDAxMjgxNjQ4MDBa
Fw0zMDAxMjgxNjQ4MDBaMIGCMQswCQYDVQQGEwJVUzEZMBcGA1UEChMQQ2xvdWRG
bGFyZSwgSW5jLjEdMBsGA1UECxMUQ2xvdWRGbGFyZSBPcmlnaW4gQ0ExOTA3BgNV
BAMTMENsb3VkRmxhcmUgT3JpZ2luIFJTQSBDZXJ0aWZpY2F0ZSBBdXRob3JpdHkw
ggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQDBguRSO20oOS2UHqA4RF/N
ZStHsMRkHxVWZIw9zc+9zWEzpNJqXLo00aPgdIoTv0TDaEngjKnLSTT2mCgISMr3
5v48I/chcDiQyMTrCunbI7ttt7ZjqxdlNuy4ognLcPYG5oKXd1eLsitkH+OcIXdl
HQVY6SPu7eISn0CCkTMSTAlXUlRWkMA6FBKe+24ohsxDWDPLrBmkKOXgVdu9ZGay
3cCOE9jNxDwkpdGDDCX03C7mQliRBxw0sHRxyjq00PDz/iO2hdLv4NJC2sV8EDGj
VCd0DCEjNQsMXNY6XB5tF2Ey7fzCoYPIHe8OjKthgL2Zkxt4uAaNAd2+NvzpxHlO
i4i1+sooLo5cj4CjSc/dkDmqqrCjbPPW4eFbPAx9wZ5lGZtd1Hfa9KJVZmQakiAO
M0eZJ8hxbP/bTCd/d/UApmpqGOqUzOEVBYMXaZ5BUFTRiBkb/vM0B4b3CAxgm5ti
XfMGiFlb0oLFDOuGAQWSrkwagLlAfGrH4FVX5xCyxjwckXx4AiXmCvWwNpxqZ2ug
jtIuHNIhFJ9GHkZUuHlcLkb/N5D6b64uMXHjTIBWSU5Vk59hf5DPkJ6fKjFfM5Ms
vYixxHy8tLT0Kq/+bzHpwn+k+H/3rPt1XB+kbccRuALo7x14U6iAYLp8VF4e8YpW
MoIXhq2LYWTzYzvZrKDa2wIDAQABo2YwZDAOBgNVHQ8BAf8EBAMCAQYwEgYDVR0T
AQH/BAgwBgEB/wIBAjAdBgNVHQ4EFgQUJOhTV118NECHqeuU27rhFnj8KaQwHwYD
VR0jBBgwFoAUJOhTV118NECHqeuU27rhFnj8KaQwDQYJKoZIhvcNAQELBQADggIB
AHwOf9Ur1l0Ar5vFE6PNrZWuDfWbbHA/tRav3/e+bPb0d6yTvw+Ze0PpjRAiLyDC
KSitk4dZB8r/z2IkTMLW3Y3XLlvE1uQSTv3eyXEwOSTyAM7bXnjg9ZbLQKCF0uvg
LwxxJ6sqPHWHRkP9c6yVuvjwLsAx4jwkDiFKJIlBQpSfJZNYoGWXqZ3Z6CbqFr9r
8vQ02TF1DnkDIvCHbYfP2T6c5eF7L2WjH0wFRfPn3HJrAa6tTy+8LaNMj/hw+KNu
VFd/A8wUBp/eQwcINvNHyNYEVPgDE2flhPHiYBWUUO8QEr2Po0KPEgF08WETbI1L
ZiGKdeC6Rgrh3/+eWnYSj8fLTV47oJR8SWYjDfGh+xX8jNbWK2nVyvqAUrO4QiPA
aHyXDYPKLGpFsNqMPjMQMLJsN7/PX5pzPTa+m6zv2K5ICFErb/J1DpoqKn8cB+S2
CHCrV1tk88bJsxE+/z8JCO5W8o0wK8ROZG5iFB5SLw9YJexhO/36YLqlj5xEvBnF
o5xKXIdHHQ9fCoBgvxhyb/qVSvBvV5R3hMyNz6EbM/P6m8owrFb8fcxhR0NHmH2k
ZHm9uLbjLXECBaZEzWGPSdL+IRX2nMPFtqKpNmLQEhL0ebUMiFE+hUPu1uYHi0Pg
lRXxJT+FyLJEOtYoKaFwprWsqsJNB43AwVh8z5DsuAt5
-----END CERTIFICATE-----
`

// ----------------------------------------------------------------------------
// Zone details / status
// ----------------------------------------------------------------------------

interface ZoneDetails {
  id: string
  name: string
  status: string
  name_servers?: string[]
  type?: string
  [k: string]: unknown
}

export async function getZoneDetails(domain: string): Promise<ZoneDetails> {
  const creds = loadCreds(domain)
  const zoneId = await getZoneId(domain)
  return cfRequest<ZoneDetails>("GET", `${CF_API}/zones/${zoneId}`, creds)
}

export async function getNameservers(domain: string): Promise<string[]> {
  const d = await getZoneDetails(domain)
  return d.name_servers ?? []
}

export async function getZoneStatus(domain: string): Promise<string> {
  const d = await getZoneDetails(domain)
  return d.status ?? "unknown"
}

// ----------------------------------------------------------------------------
// Zone create — with self-heal on stale account_id
// ----------------------------------------------------------------------------

interface CreateZoneResult {
  zone_id: string
  nameservers: string[]
  status: string
}

interface CfApiError { code: number; message: string }

interface RawCfResponse {
  status: number
  ok: boolean
  json: { success?: boolean; result?: ZoneDetails | ZoneDetails[]; errors?: CfApiError[] } | null
  text: string
}

async function rawCfPost(url: string, body: unknown, headers: Record<string, string>): Promise<RawCfResponse> {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
  const text = await res.text()
  let json: RawCfResponse["json"] = null
  try { json = text ? JSON.parse(text) : null } catch { /* keep null */ }
  return { status: res.status, ok: res.ok, json, text }
}

function isAccountError(resp: RawCfResponse): boolean {
  if (resp.ok) return false
  const errs = resp.json?.errors ?? []
  if (errs.some((e) => e.code === 1013 || e.code === 1003 || e.code === 9101)) return true
  const txt = (resp.text || "").toLowerCase()
  return txt.includes("account") &&
    (txt.includes("invalid") || txt.includes("not a valid") || txt.includes("not authorized"))
}

function isAlreadyExistsError(resp: RawCfResponse): boolean {
  const errs = resp.json?.errors ?? []
  return errs.some(
    (e) => e.code === 1061 || e.code === 1097 || e.code === 1100 ||
      (e.message ?? "").toLowerCase().includes("already exists"),
  )
}

/**
 * Add a domain to its assigned CF account (cf_email/cf_global_key/cf_account_id
 * must already be populated by cf_key_pool.assignCfKeyToDomain).
 *
 * Self-healing: if the POST fails because cf_account_id is stale (a frequent
 * legacy bug — old code stored user.id rather than account.id), we re-fetch
 * the real id from /accounts and retry once.
 *
 * Idempotent: if the zone already exists in this account, we GET it and
 * return its details rather than erroring.
 */
export async function createZoneForDomain(domain: string): Promise<CreateZoneResult> {
  const d = getDomain(domain)
  if (!d || !d.cf_email || !d.cf_global_key || !d.cf_account_id) {
    throw new Error(
      `${domain}: cf_email / cf_global_key / cf_account_id missing — ` +
      `run cf_key_pool.assignCfKeyToDomain(domain) first`,
    )
  }
  const headers = {
    "X-Auth-Email": d.cf_email,
    "X-Auth-Key": d.cf_global_key,
    "Content-Type": "application/json",
  }

  async function attempt(accountId: string): Promise<RawCfResponse> {
    logPipeline(domain, "cf_add_zone", "running",
      `Adding ${domain} to CF account ${accountId.slice(0, 12)}...`)
    return rawCfPost(`${CF_API}/zones`, {
      name: domain,
      account: { id: accountId },
      type: "full",
      jump_start: false,
    }, headers)
  }

  let resp = await attempt(d.cf_account_id)

  // Self-heal: stale account_id → refresh + retry once
  if (isAccountError(resp) && d.cf_key_id) {
    logPipeline(domain, "cf_add_zone", "warning",
      `Zone create failed (HTTP ${resp.status}) — refreshing account_id from /accounts`)
    try {
      const newAcct = await refreshCfAccountId(d.cf_key_id)
      resp = await attempt(newAcct)
      logPipeline(domain, "cf_add_zone", "running",
        `Retry with fresh account_id ${newAcct.slice(0, 12)}... → HTTP ${resp.status}`)
    } catch (e) {
      logPipeline(domain, "cf_add_zone", "warning",
        `Account-id refresh itself failed: ${(e as Error).message}`)
    }
  }

  let z: ZoneDetails | null = null
  if (!resp.ok) {
    if (isAlreadyExistsError(resp)) {
      logPipeline(domain, "cf_add_zone", "running",
        "Zone already exists in account — fetching info")
      const creds: DomainCreds = { cf_email: d.cf_email, cf_global_key: d.cf_global_key }
      const zones = await cfRequest<ZoneDetails[]>(
        "GET",
        `${CF_API}/zones?name=${encodeURIComponent(domain)}`,
        creds,
      )
      if (!zones.length) throw new Error(`CF says zone exists but GET returned none`)
      z = zones[0]
    } else {
      const msg = resp.json?.errors?.map((e) => `${e.code}:${e.message}`).join("; ") ??
        `HTTP ${resp.status}`
      throw new Error(`CF zone create: ${msg}`)
    }
  } else {
    z = (resp.json?.result as ZoneDetails | undefined) ?? null
  }
  if (!z) throw new Error(`CF zone create: no result in response`)

  const zoneId = z.id
  const nameservers = z.name_servers ?? []
  const status = z.status ?? "pending"

  updateDomain(domain, {
    cf_zone_id: zoneId,
    cf_nameservers: nameservers.join(","),
  } as Parameters<typeof updateDomain>[1])

  logPipeline(domain, "cf_add_zone", "completed",
    `zone_id=${zoneId}  ns=${nameservers.join(",")}  status=${status}`)
  return { zone_id: zoneId, nameservers, status }
}

// ----------------------------------------------------------------------------
// Zone delete
// ----------------------------------------------------------------------------

export async function deleteZone(domain: string): Promise<{ ok: boolean; message: string }> {
  logPipeline(domain, "cf_delete_zone", "running", `Deleting ${domain} zone from Cloudflare...`)
  try {
    const creds = loadCreds(domain)
    const zoneId = await getZoneId(domain)
    await cfRequest<{ id: string }>("DELETE", `${CF_API}/zones/${zoneId}`, creds)
    logPipeline(domain, "cf_delete_zone", "completed", `Zone ${zoneId} deleted from CF`)
    return { ok: true, message: "Zone deleted" }
  } catch (e) {
    const msg = (e as Error).message
    logPipeline(domain, "cf_delete_zone", "failed", msg)
    return { ok: false, message: msg }
  }
}

// ----------------------------------------------------------------------------
// Origin CA cert issuance — RSA-2048 keypair + CSR generated locally
// ----------------------------------------------------------------------------

function generateCsrAndKey(domain: string): { csrPem: string; keyPem: string } {
  // node-forge: generate RSA-2048, build a CSR with SAN [domain, *.domain]
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
  const csr = forge.pki.createCertificationRequest()
  csr.publicKey = keys.publicKey
  csr.setSubject([{ name: "commonName", value: domain }])
  csr.setAttributes([
    {
      name: "extensionRequest",
      extensions: [
        {
          name: "subjectAltName",
          altNames: [
            { type: 2, value: domain },        // type 2 = DNSName
            { type: 2, value: `*.${domain}` },
          ],
        },
      ],
    },
  ])
  csr.sign(keys.privateKey, forge.md.sha256.create())
  const csrPem = forge.pki.certificationRequestToPem(csr)
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey)
  return { csrPem, keyPem }
}

export interface OriginCaCert {
  certificate: string
  private_key: string
  chain: string
  id: string
  expires_on: string
}

/**
 * Issue a CF Origin CA cert for `domain` + `*.domain`. RSA-2048 keypair is
 * generated locally; the private key never leaves this machine. CF signs
 * the CSR; chain is the CF Origin CA RSA Root.
 *
 * `validityDays` must be a CF-accepted value (7 / 30 / 90 / 365 / 730 / 1095 / 5475).
 * Default 5475 (15 years).
 *
 * If `originCaKey` is provided, auth is via X-Auth-User-Service-Key. Otherwise
 * we fall back to the domain's pool-assigned Global API Key.
 */
export async function fetchOriginCaCert(
  domain: string,
  validityDays = 5475,
  originCaKey?: string,
): Promise<OriginCaCert> {
  logPipeline(domain, "cf_origin_ca", "running",
    `Issuing Origin CA cert for ${domain} (+*.${domain}), validity=${validityDays}d`)
  try {
    const { csrPem, keyPem } = generateCsrAndKey(domain)

    let headers: Record<string, string>
    if (originCaKey) {
      headers = {
        "X-Auth-User-Service-Key": originCaKey,
        "Content-Type": "application/json",
      }
    } else {
      const d = getDomain(domain)
      if (!d || !d.cf_email || !d.cf_global_key) {
        throw new Error(`${domain}: no CF credentials available for Origin CA issuance`)
      }
      headers = {
        "X-Auth-Email": d.cf_email,
        "X-Auth-Key": d.cf_global_key,
        "Content-Type": "application/json",
      }
    }

    const body = {
      csr: csrPem,
      hostnames: [domain, `*.${domain}`],
      request_type: "origin-rsa",
      requested_validity: Math.floor(validityDays),
    }
    const resp = await rawCfPost(`${CF_API}/certificates`, body, headers)
    if (!resp.ok || !resp.json?.success) {
      const errs = resp.json?.errors?.map((e) => `${e.code}:${e.message}`).join("; ")
      const msg = errs || resp.text.slice(0, 400)
      logPipeline(domain, "cf_origin_ca", "failed", msg.slice(0, 500))
      throw new Error(`CF Origin CA refused: HTTP ${resp.status} — ${msg}`)
    }
    const result = resp.json.result as { certificate?: string; id?: string; expires_on?: string } | undefined
    const certPem = result?.certificate ?? ""
    if (!certPem) {
      throw new Error(`CF Origin CA returned no certificate: ${resp.text.slice(0, 300)}`)
    }
    logPipeline(domain, "cf_origin_ca", "completed",
      `cert id=${result?.id ?? ""} expires=${result?.expires_on ?? ""}`)
    return {
      certificate: certPem,
      private_key: keyPem,
      chain: CF_ORIGIN_CA_RSA_ROOT_PEM,
      id: result?.id ?? "",
      expires_on: result?.expires_on ?? "",
    }
  } catch (e) {
    const msg = (e as Error).message
    logPipeline(domain, "cf_origin_ca", "failed", msg.slice(0, 500))
    throw e
  }
}
