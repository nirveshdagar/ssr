import { NextResponse, type NextRequest } from "next/server"
import { all, one, run } from "@/lib/db"
import { appendAudit } from "@/lib/repos/audit"
import { logPipeline } from "@/lib/repos/logs"

export const runtime = "nodejs"

const CF_API = "https://api.cloudflare.com/client/v4"

interface KeyRow {
  id: number
  email: string
  api_key: string
  alias: string | null
  cf_account_id: string | null
  is_active: number
}

interface CfZone {
  id: string
  name: string
  status: string
  /** CF-assigned nameservers — present in GET /zones, was being discarded. */
  name_servers?: string[]
}

interface CfZonesResponse {
  success?: boolean
  errors?: { code: number; message: string }[]
  result?: CfZone[]
}

interface DomainRow {
  domain: string
  cf_key_id: number | null
  cf_zone_id: string | null
  cf_nameservers: string | null
  status: string
}

interface KeyReport {
  key_id: number
  alias: string | null
  email: string
  zones_in_cf: number
  domains_tracked: number
  /** DB rows whose cf_zone_id no longer matches a live CF zone. */
  ssr_orphans: { domain: string; cf_zone_id: string | null; ssr_status: string }[]
  /** CF zones not tracked in our DB at all. */
  cf_untracked: { name: string; cf_zone_id: string; cf_status: string }[]
  /** DB rows where cf_zone_id is null/stale BUT a name match exists on CF —
   *  backfilled cf_zone_id (and cf_account_id) on this run. */
  backfilled: { domain: string; before_zone_id: string | null; after_zone_id: string }[]
  error: string | null
}

/**
 * Cloudflare sync — walks every active CF key, lists its zones, and
 * reconciles against the `domains` table. Three classes of drift surfaced:
 *
 * 1. SSR_orphans: DB row claims `cf_zone_id=X` but CF doesn't list X for
 *    this key's account. Likely the zone was deleted via the CF dashboard
 *    or a different SSR install. Operator should hard-delete the domain
 *    or run the pipeline again from step 3 (zone create).
 *
 * 2. CF_untracked: CF has a zone we don't track. Either an external admin
 *    added it, or our DB was reset. Operator can add it manually via the
 *    /domains page or import-from-sa.
 *
 * 3. Backfillable: DB row with `cf_zone_id=NULL` but the same name DOES
 *    exist on CF — common when the pipeline crashed between Spaceship
 *    create and CF zone create, but the zone was created later out-of-band.
 *    These are ALWAYS auto-fixed (cf_zone_id + cf_account_id back-filled)
 *    because the data is unambiguous and the fix is non-destructive.
 *
 * Form params:
 *   dry_run=on   — preview only, skip the backfill writes (still surfaces
 *                  the same report shape)
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const dryRun = ((form?.get("dry_run") as string | null) || "") === "on"

  const keys = all<KeyRow>(
    `SELECT id, email, api_key, alias, cf_account_id, is_active
       FROM cf_keys WHERE is_active = 1 ORDER BY id ASC`,
  )
  if (keys.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "No active CF keys to sync",
      reports: [] as KeyReport[],
      summary: { keys_synced: 0, ssr_orphans: 0, cf_untracked: 0, backfilled: 0, errors: 0 },
    })
  }

  const reports: KeyReport[] = []
  let backfilledTotal = 0

  for (const k of keys) {
    const report: KeyReport = {
      key_id: k.id,
      alias: k.alias,
      email: k.email,
      zones_in_cf: 0,
      domains_tracked: 0,
      ssr_orphans: [],
      cf_untracked: [],
      backfilled: [],
      error: null,
    }

    if (!k.cf_account_id) {
      report.error = "cf_account_id missing — run 'Refresh accounts' first"
      reports.push(report)
      continue
    }

    // Pull all zones for this CF account (paginated, CF caps at 50/page).
    let zones: CfZone[]
    try {
      zones = await listAllZones(k.email, k.api_key, k.cf_account_id)
    } catch (e) {
      report.error = `CF list-zones failed: ${(e as Error).message}`
      reports.push(report)
      continue
    }
    report.zones_in_cf = zones.length

    // DB rows assigned to this key.
    const tracked = all<DomainRow>(
      `SELECT domain, cf_key_id, cf_zone_id, cf_nameservers, status FROM domains WHERE cf_key_id = ?`,
      k.id,
    )
    report.domains_tracked = tracked.length

    const cfByName = new Map<string, CfZone>()
    for (const z of zones) cfByName.set(z.name.toLowerCase(), z)
    const cfById = new Map<string, CfZone>()
    for (const z of zones) cfById.set(z.id, z)

    // Pass 1: orphans + backfill candidates. Backfills cf_zone_id +
    // cf_account_id AND cf_nameservers. The last was previously never
    // captured here, so SA-imported / externally-synced domains (which
    // import-from-sa creates with no CF fields at all) never got their
    // CF nameservers recorded — that was the reported "sync doesn't
    // update the nameservers" bug.
    for (const d of tracked) {
      const lower = d.domain.toLowerCase()
      const byIdMatch = d.cf_zone_id ? cfById.get(d.cf_zone_id) : null
      const byNameMatch = cfByName.get(lower)
      const zone = byIdMatch ?? byNameMatch
      if (!zone) {
        // Neither id nor name matches — true orphan.
        report.ssr_orphans.push({
          domain: d.domain,
          cf_zone_id: d.cf_zone_id,
          ssr_status: d.status,
        })
        continue
      }
      const nsStr = Array.isArray(zone.name_servers) ? zone.name_servers.join(",") : ""
      const needZoneId = !byIdMatch && !!byNameMatch // cf_zone_id null/stale
      const needNs = (!d.cf_nameservers || !d.cf_nameservers.trim()) && nsStr !== ""
      if (!needZoneId && !needNs) continue // happy path — fully resolved
      if (!dryRun) {
        // Non-destructive: only fill cf_nameservers when it's empty.
        run(
          `UPDATE domains
              SET cf_zone_id = ?, cf_account_id = ?,
                  cf_nameservers = COALESCE(NULLIF(cf_nameservers, ''), ?),
                  updated_at = datetime('now')
            WHERE domain = ?`,
          zone.id, k.cf_account_id, nsStr || null, d.domain,
        )
        logPipeline(d.domain, "cf_sync", "completed",
          `Backfilled` +
          (needZoneId ? ` cf_zone_id=${zone.id} (was ${d.cf_zone_id ?? "NULL"})` : "") +
          (needNs ? ` cf_nameservers=${nsStr}` : "") +
          ` — matched on CF`)
        backfilledTotal++
      }
      report.backfilled.push({
        domain: d.domain,
        before_zone_id: d.cf_zone_id,
        after_zone_id: zone.id,
      })
    }

    // Pass 2: CF zones not referenced by any DB row of THIS key.
    const trackedNames = new Set(tracked.map((d) => d.domain.toLowerCase()))
    for (const z of zones) {
      if (trackedNames.has(z.name.toLowerCase())) continue
      // Does a DOMAIN row with this name exist anywhere?
      const existing = one<{ cf_key_id: number | null; cf_nameservers: string | null }>(
        `SELECT cf_key_id, cf_nameservers FROM domains WHERE LOWER(domain) = ? LIMIT 1`,
        z.name.toLowerCase(),
      )
      if (existing && existing.cf_key_id != null && existing.cf_key_id !== k.id) {
        // Domain row exists on a DIFFERENT key — its own kind of drift,
        // not "untracked from this key's perspective". Skip.
        continue
      }
      if (existing && existing.cf_key_id == null) {
        // UNLINKED domain row (e.g. import-from-sa creates rows with no CF
        // fields at all) whose name matches a zone in THIS key's account.
        // Link it: assign the key + zone + account + nameservers. This is
        // the case that was previously only flagged "cf_untracked" and
        // never fixed — the reported "sync doesn't set nameservers for
        // SA-imported domains" bug. Non-destructive (only fills NULLs).
        const nsStr = Array.isArray(z.name_servers) ? z.name_servers.join(",") : ""
        if (!dryRun) {
          run(
            `UPDATE domains
                SET cf_key_id = ?, cf_zone_id = ?, cf_account_id = ?,
                    cf_nameservers = COALESCE(NULLIF(cf_nameservers, ''), ?),
                    updated_at = datetime('now')
              WHERE LOWER(domain) = ?`,
            k.id, z.id, k.cf_account_id, nsStr || null, z.name.toLowerCase(),
          )
          logPipeline(z.name, "cf_sync", "completed",
            `Linked unlinked domain to CF: cf_key_id=${k.id} cf_zone_id=${z.id}` +
            (nsStr ? ` cf_nameservers=${nsStr}` : "") + " — name matched on CF")
          backfilledTotal++
        }
        report.backfilled.push({
          domain: z.name,
          before_zone_id: null,
          after_zone_id: z.id,
        })
        continue
      }
      report.cf_untracked.push({
        name: z.name,
        cf_zone_id: z.id,
        cf_status: z.status,
      })
    }

    reports.push(report)
  }

  const summary = {
    keys_synced: reports.filter((r) => r.error === null).length,
    ssr_orphans: reports.reduce((n, r) => n + r.ssr_orphans.length, 0),
    cf_untracked: reports.reduce((n, r) => n + r.cf_untracked.length, 0),
    backfilled: backfilledTotal,
    errors: reports.filter((r) => r.error !== null).length,
  }

  if (!dryRun && backfilledTotal > 0) {
    appendAudit(
      "cf_sync", "",
      `keys=${summary.keys_synced} backfilled=${summary.backfilled} ` +
      `orphans=${summary.ssr_orphans} untracked=${summary.cf_untracked} errors=${summary.errors}`,
      ip,
    )
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    reports,
    summary,
    message:
      `Synced ${summary.keys_synced}/${keys.length} key(s). ` +
      `Backfilled ${summary.backfilled}, ` +
      `${summary.ssr_orphans} DB orphan(s) (zone gone on CF), ` +
      `${summary.cf_untracked} CF zone(s) not in DB` +
      (summary.errors > 0 ? `, ${summary.errors} key(s) errored` : "") +
      (dryRun ? " — dry run, no writes" : ""),
  })
}

async function listAllZones(email: string, apiKey: string, accountId: string): Promise<CfZone[]> {
  const out: CfZone[] = []
  let page = 1
  while (page < 100) {
    const url =
      `${CF_API}/zones?account.id=${encodeURIComponent(accountId)}` +
      `&per_page=50&page=${page}`
    const res = await fetch(url, {
      headers: {
        "X-Auth-Email": email,
        "X-Auth-Key": apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const body = (await res.json()) as CfZonesResponse
    if (!body.success) {
      const msg = body.errors?.map((e) => `${e.code}:${e.message}`).join("; ") ?? "unknown"
      throw new Error(`CF rejected: ${msg}`)
    }
    const got = body.result ?? []
    out.push(...got)
    if (got.length < 50) break
    page++
  }
  return out
}
