/**
 * Job handlers for cf.* job kinds. Each handler iterates a domain list
 * and applies the same CF API calls per row that the Flask side does;
 * per-domain failures don't abort the rest.
 */
import { run } from "../db"
import {
  setDnsARecord,
  setDnsARecordWww,
  setSslMode,
  setAlwaysUseHttps,
  upsertDnsRecord,
  type SslMode,
  type DnsRecordType,
} from "../cloudflare"

function logPipeline(domain: string, step: string, status: string, message: string): void {
  run(
    "INSERT INTO pipeline_log (domain, step, status, message) VALUES (?, ?, ?, ?)",
    domain,
    step,
    status,
    message,
  )
}

export async function cfBulkSetIp(payload: Record<string, unknown>): Promise<void> {
  const newIp = String(payload.new_ip)
  const proxied = Boolean(payload.proxied)
  const domains = (payload.domains as string[]) ?? []
  let ok = 0
  let fail = 0
  for (const d of domains) {
    try {
      await setDnsARecord(d, newIp, proxied)
      await setDnsARecordWww(d, newIp, proxied)
      run(
        "UPDATE domains SET current_proxy_ip = ?, updated_at = datetime('now') WHERE domain = ?",
        newIp,
        d,
      )
      logPipeline(d, "bulk_set_ip", "completed", `A records -> ${newIp} (proxied=${proxied})`)
      ok++
    } catch (e) {
      logPipeline(d, "bulk_set_ip", "failed", `set A record failed: ${(e as Error).message}`)
      fail++
    }
  }
  logPipeline(
    "cf_bulk_set_ip",
    "bulk_set_ip",
    fail ? "warning" : "completed",
    `new_ip=${newIp} proxied=${proxied} ok=${ok} failed=${fail}`,
  )
}

export async function cfBulkSetSettings(payload: Record<string, unknown>): Promise<void> {
  const sslMode = (payload.ssl_mode ?? null) as SslMode | null
  const alwaysHttps = (payload.always_https ?? null) as boolean | null
  const domains = (payload.domains as string[]) ?? []
  let ok = 0
  let fail = 0
  for (const d of domains) {
    try {
      if (sslMode) await setSslMode(d, sslMode)
      if (alwaysHttps !== null) await setAlwaysUseHttps(d, alwaysHttps)
      logPipeline(
        d,
        "bulk_set_settings",
        "completed",
        `ssl_mode=${sslMode} always_https=${alwaysHttps}`,
      )
      ok++
    } catch (e) {
      logPipeline(d, "bulk_set_settings", "failed", `settings change failed: ${(e as Error).message}`)
      fail++
    }
  }
  logPipeline(
    "cf_bulk_set_settings",
    "bulk_set_settings",
    fail ? "warning" : "completed",
    `ssl_mode=${sslMode} always_https=${alwaysHttps} ok=${ok} failed=${fail}`,
  )
}

interface CsvRow {
  domain: string
  type: DnsRecordType | string
  name: string
  content: string
  proxied: boolean
  ttl: number
}

export async function cfBulkDnsCsv(payload: Record<string, unknown>): Promise<void> {
  const rows = (payload.rows as CsvRow[]) ?? []
  let ok = 0
  let fail = 0
  for (const row of rows) {
    try {
      await upsertDnsRecord({
        domain: row.domain,
        type: row.type,
        name: row.name,
        content: row.content,
        proxied: row.proxied,
        ttl: row.ttl,
      })
      logPipeline(
        row.domain,
        "bulk_dns_csv",
        "completed",
        `${row.type} ${JSON.stringify(row.name)} -> ${row.content.slice(0, 60)} (proxied=${row.proxied})`,
      )
      ok++
    } catch (e) {
      logPipeline(
        row.domain,
        "bulk_dns_csv",
        "failed",
        `${row.type} ${JSON.stringify(row.name)} upsert failed: ${(e as Error).message}`,
      )
      fail++
    }
  }
  logPipeline("cf_bulk_dns_csv", "bulk_dns_csv", fail ? "warning" : "completed", `ok=${ok} failed=${fail}`)
}
