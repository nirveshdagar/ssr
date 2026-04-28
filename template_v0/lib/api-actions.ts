/**
 * Client-side action helpers — wraps the operator API routes with friendly
 * functions returning `{ok, message?, error?}` so page components can
 * `await deleteDomain('foo.com')` without re-implementing fetch + error parsing
 * everywhere.
 *
 * All functions are POST (or DELETE/GET where appropriate) with form-encoded
 * bodies (matching the server-side route handlers' expectations) and
 * `credentials: 'same-origin'` so the iron-session cookie is sent.
 */

interface ActionResult<T = unknown> {
  ok: boolean
  message?: string
  error?: string
  data?: T
}

async function postForm<T = unknown>(
  url: string, body: Record<string, string | undefined> = {},
): Promise<ActionResult<T>> {
  const fd = new FormData()
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined) fd.set(k, v)
  }
  try {
    const r = await fetch(url, { method: "POST", body: fd, credentials: "same-origin" })
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!r.ok) {
      return { ok: false, error: String(j.error ?? `HTTP ${r.status}`) }
    }
    return {
      ok: Boolean(j.ok ?? true),
      message: typeof j.message === "string" ? j.message : undefined,
      error: typeof j.error === "string" ? j.error : undefined,
      data: j as T,
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

async function getJson<T = unknown>(url: string): Promise<ActionResult<T>> {
  try {
    const r = await fetch(url, { credentials: "same-origin" })
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (!r.ok) return { ok: false, error: String(j.error ?? `HTTP ${r.status}`) }
    return { ok: true, data: j as T }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Domain actions
// ---------------------------------------------------------------------------

export const domainActions = {
  delete: (domain: string) => postForm(`/api/domains/${domain}/delete`),
  fullDelete: (domain: string) => postForm(`/api/domains/${domain}/full-delete`),
  bulkDelete: (domainIds: string[], deleteFrom: "db_only" | "all" = "all") => {
    const fd = new FormData()
    for (const id of domainIds) fd.append("domain_ids", id)
    fd.set("delete_from", deleteFrom)
    return fetch("/api/domains/bulk-delete", { method: "POST", body: fd, credentials: "same-origin" })
      .then(async (r) => ({ ok: r.ok, ...((await r.json()) as Record<string, unknown>) }))
  },
  cancelPipeline: (domain: string) => postForm(`/api/domains/${domain}/cancel-pipeline`),
  runPipeline: (
    domain: string,
    opts: {
      skipPurchase?: boolean
      serverId?: number
      startFrom?: number
      forceNewServer?: boolean
    } = {},
  ) => postForm(`/api/domains/${domain}/run-pipeline`, {
    skip_purchase: opts.skipPurchase ? "on" : undefined,
    server_id: opts.serverId != null ? String(opts.serverId) : undefined,
    start_from: opts.startFrom != null ? String(opts.startFrom) : undefined,
    force_new_server: opts.forceNewServer ? "on" : undefined,
  }),
  runFromStep: (domain: string, step: number, skipPurchase = false) =>
    postForm(`/api/domains/${domain}/run-from/${step}`, {
      skip_purchase: skipPurchase ? "on" : undefined,
    }),
  runBulk: (
    domainIds: string[],
    opts: { skipPurchase?: boolean; serverId?: number; forceNewServer?: boolean } = {},
  ) => {
    const fd = new FormData()
    for (const id of domainIds) fd.append("domain_ids", id)
    if (opts.skipPurchase) fd.set("skip_purchase", "on")
    if (opts.serverId != null) fd.set("server_id", String(opts.serverId))
    if (opts.forceNewServer) fd.set("force_new_server", "on")
    return fetch("/api/domains/run-bulk", { method: "POST", body: fd, credentials: "same-origin" })
      .then(async (r) => ({ ok: r.ok, ...((await r.json()) as Record<string, unknown>) }))
  },
  updateCf: (domain: string, fields: { cf_email?: string; cf_global_key?: string; cf_zone_id?: string }) =>
    postForm(`/api/domains/${domain}/update-cf`, fields),
  override: (domain: string, field: string, value: string) =>
    postForm(`/api/domains/${domain}/override-field`, { field, value }),
  checkNs: (domain: string) => postForm(`/api/domains/${domain}/check-ns`),
  checkAllNs: () => postForm("/api/domains/check-all-ns"),
  preflight: (domain: string, skipPurchase = false) =>
    getJson(`/api/preflight/${domain}${skipPurchase ? "?skip_purchase=on" : ""}`),
  syncFromSa: () => postForm("/api/domains/sync-from-sa"),
  importFromSa: () => postForm("/api/domains/import-from-sa"),
  backfillOriginCerts: () => postForm("/api/domains/backfill-origin-certs"),
}

// ---------------------------------------------------------------------------
// Server actions
// ---------------------------------------------------------------------------

export const serverActions = {
  create: (opts: { name?: string; region?: string; size?: string }) =>
    postForm("/api/servers/create", {
      name: opts.name,
      region: opts.region,
      size: opts.size,
    }),
  addExisting: (name: string, ip: string, saServerId?: string) =>
    postForm("/api/servers/add-existing", {
      name, ip,
      sa_server_id: saServerId,
    }),
  edit: (id: number, name: string, maxSites: number) =>
    postForm(`/api/servers/${id}/edit`, {
      name, max_sites: String(maxSites),
    }),
  dbDelete: (id: number) => postForm(`/api/servers/${id}/db-delete`),
  markDead: (id: number) => postForm(`/api/servers/${id}/mark-dead`),
  markReady: (id: number) => postForm(`/api/servers/${id}/mark-ready`),
  migrateNow: (id: number, targetServerId?: number) =>
    postForm(`/api/servers/${id}/migrate-now`, {
      target_server_id: targetServerId != null ? String(targetServerId) : undefined,
    }),
  destroyAll: (confirmPhrase: string) =>
    postForm("/api/servers/destroy-all", { confirm_phrase: confirmPhrase }),
  syncFromDo: () => postForm("/api/servers/sync-from-do"),
  importFromDo: () => postForm("/api/servers/import-from-do"),
  /**
   * Walk SA, match each connected SA server to a DB row by IP, and back-fill
   * sa_server_id + status='ready' on rows that lost their link (e.g. SSH
   * timeout aborted a step-6 install before the sa_server_id was written).
   * Pass `dryRun=true` to preview without writing.
   */
  reconcileFromSa: (dryRun = false) =>
    postForm("/api/servers/reconcile-from-sa", { dry_run: dryRun ? "on" : undefined }),
  /**
   * Manually fire one auto-heal sweep — same logic that runs every
   * SSR_AUTOHEAL_INTERVAL_MS in the background. Reconciles orphans + resumes
   * any pipelines that were waiting on them + advances NS-pending domains
   * whose CF zones have gone active.
   */
  autoHealTick: () => postForm("/api/system/auto-heal-tick"),
  /** Hard delete — destroys DO droplet + SA server + DB row. Requires typed-name match. */
  delete: (id: number, confirmName: string) =>
    postForm(`/api/servers/${id}/delete`, { confirm_name: confirmName }),
}

// ---------------------------------------------------------------------------
// CF key actions
// ---------------------------------------------------------------------------

export const cfKeyActions = {
  add: (email: string, apiKey: string, alias?: string) =>
    postForm("/api/cf-keys/add", { email, api_key: apiKey, alias }),
  edit: (id: number, alias: string | null, maxDomains: number) =>
    postForm(`/api/cf-keys/${id}/edit`, {
      alias: alias ?? "",
      max_domains: String(maxDomains),
    }),
  toggle: (id: number) => postForm(`/api/cf-keys/${id}/toggle`),
  refreshAccounts: () => postForm("/api/cf-keys/refresh-accounts"),
  bulkSetIp: (id: number, domains: string[], newIp: string, proxied = true) => {
    const fd = new FormData()
    for (const d of domains) fd.append("domains", d)
    fd.set("new_ip", newIp)
    if (proxied) fd.set("proxied", "on")
    return fetch(`/api/cf-keys/${id}/bulk-set-ip`,
      { method: "POST", body: fd, credentials: "same-origin" })
      .then(async (r) => ({ ok: r.ok, ...((await r.json()) as Record<string, unknown>) }))
  },
  bulkSetSettings: (
    id: number, domains: string[],
    settings: { ssl_mode?: string; always_https?: string },
  ) => {
    const fd = new FormData()
    for (const d of domains) fd.append("domains", d)
    if (settings.ssl_mode) fd.set("ssl_mode", settings.ssl_mode)
    if (settings.always_https) fd.set("always_https", settings.always_https)
    return fetch(`/api/cf-keys/${id}/bulk-set-settings`,
      { method: "POST", body: fd, credentials: "same-origin" })
      .then(async (r) => ({ ok: r.ok, ...((await r.json()) as Record<string, unknown>) }))
  },
  bulkDnsCsv: (id: number, csvText: string, csvFile?: File | null) => {
    const fd = new FormData()
    if (csvText) fd.set("csv_text", csvText)
    if (csvFile) fd.set("csv_file", csvFile)
    return fetch(`/api/cf-keys/${id}/bulk-dns-csv`,
      { method: "POST", body: fd, credentials: "same-origin" })
      .then(async (r) => ({ ok: r.ok, ...((await r.json()) as Record<string, unknown>) }))
  },
}

// ---------------------------------------------------------------------------
// Heartbeat lookup (for live indicators on the domains page)
// ---------------------------------------------------------------------------

export const watcherActions = {
  heartbeat: (domain: string) =>
    getJson<{
      domain: string
      last_heartbeat_at: string | null
      seconds_ago: number | null
      alive: boolean
    }>(`/api/heartbeat/${domain}`),
}
