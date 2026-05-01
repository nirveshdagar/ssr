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
    // Spread body fields onto the top level so callers that cast to a flat
    // shape (`as { added?: number; ... }`) read real values instead of
    // undefined. The structured ok/message/error/data come last so they win
    // over body keys with the same name.
    return {
      ...j,
      ok: Boolean(j.ok ?? true),
      message: typeof j.message === "string" ? j.message : undefined,
      error: typeof j.error === "string" ? j.error : undefined,
      data: j as T,
    } as ActionResult<T>
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
  bulkDelete: (
    domainIds: string[],
    deleteFrom: "db_only" | "all" | "all_parallel" = "all",
  ) => {
    const fd = new FormData()
    for (const id of domainIds) fd.append("domain_ids", id)
    fd.set("delete_from", deleteFrom)
    return fetch("/api/domains/bulk-delete", { method: "POST", body: fd, credentials: "same-origin" })
      .then(async (r) => ({ ok: r.ok, ...((await r.json()) as Record<string, unknown>) }))
  },
  cancelPipeline: (domain: string) => postForm(`/api/domains/${domain}/cancel-pipeline`),
  /**
   * Force a fresh TLS probe of the origin and update ssl_origin_ok in DB.
   * Use this when the lock icon disagrees with the operator's expectation —
   * `result === false` flips the lock red and shows what cert is actually
   * being served (issuer / subject CN).
   */
  checkSslNow: (domain: string) => postForm<{
    probed_ip?: string
    result?: boolean | null
    issuer?: string | null
    subject?: string | null
    message?: string
    ssl_last_verified_at?: string | null
  }>(`/api/domains/${domain}/check-ssl-now`),
  /** Force a fresh HTTPS liveness probe and update live_* columns. */
  checkLiveNow: (domain: string) => postForm<{
    result?: boolean
    reason?: string
    http_status?: number | null
    checked_at?: string
  }>(`/api/domains/${domain}/check-live-now`),
  runPipeline: (
    domain: string,
    opts: {
      skipPurchase?: boolean
      serverId?: number
      startFrom?: number
      forceNewServer?: boolean
      customProvider?: string
      customModel?: string
    } = {},
  ) => postForm(`/api/domains/${domain}/run-pipeline`, {
    skip_purchase: opts.skipPurchase ? "on" : undefined,
    server_id: opts.serverId != null ? String(opts.serverId) : undefined,
    start_from: opts.startFrom != null ? String(opts.startFrom) : undefined,
    force_new_server: opts.forceNewServer ? "on" : undefined,
    custom_provider: opts.customProvider || undefined,
    custom_model: opts.customModel || undefined,
  }),
  /**
   * Re-run the pipeline starting from `step`. The optional `customPrompt` /
   * `customProvider` / `customModel` are only meaningful when step <= 9 —
   * the orchestrator threads them into step 9's LLM call so the operator
   * can override the auto-inferred niche, the active provider, or the model
   * for this run only. Empty fields fall through to global settings.
   */
  runFromStep: async (
    domain: string, step: number,
    opts: {
      skipPurchase?: boolean
      customPrompt?: string | null
      customProvider?: string | null
      customModel?: string | null
      /** When true, step 9 ignores the cached site_html and re-runs the
       *  LLM. Used by the AI Generator's Regenerate flow. */
      forceRegen?: boolean
      /** Per-run override of the system/master prompt — wins over the
       *  global llm_master_prompt setting for THIS pipeline run only. */
      customMasterPrompt?: string | null
    } = {},
  ): Promise<ActionResult> => {
    try {
      const r = await fetch(`/api/domains/${domain}/run-from/${step}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          skip_purchase: opts.skipPurchase ? "on" : undefined,
          custom_prompt: opts.customPrompt ?? undefined,
          custom_provider: opts.customProvider ?? undefined,
          custom_model: opts.customModel ?? undefined,
          custom_master_prompt: opts.customMasterPrompt ?? undefined,
          force_regen: opts.forceRegen ? "on" : undefined,
        }),
      })
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
      return {
        ok: r.ok && (j.ok !== false),
        message: typeof j.message === "string" ? j.message : undefined,
        error: typeof j.error === "string" ? j.error : undefined,
        data: j,
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },
  runBulk: (
    domainIds: string[],
    opts: {
      skipPurchase?: boolean; serverId?: number; forceNewServer?: boolean
      customProvider?: string; customModel?: string
    } = {},
  ) => {
    const fd = new FormData()
    for (const id of domainIds) fd.append("domain_ids", id)
    if (opts.skipPurchase) fd.set("skip_purchase", "on")
    if (opts.serverId != null) fd.set("server_id", String(opts.serverId))
    if (opts.forceNewServer) fd.set("force_new_server", "on")
    if (opts.customProvider) fd.set("custom_provider", opts.customProvider)
    if (opts.customModel) fd.set("custom_model", opts.customModel)
    return fetch("/api/domains/run-bulk", { method: "POST", body: fd, credentials: "same-origin" })
      .then(async (r) => ({ ok: r.ok, ...((await r.json()) as Record<string, unknown>) }))
  },
  /**
   * Sequential variant — same input shape as runBulk but the backend
   * enqueues a single pipeline.bulk job that walks the selected domains
   * one-at-a-time in one worker. Smaller external-API blast radius;
   * total wall-time = sum of per-domain durations.
   */
  runBulkSequential: (
    domainIds: string[],
    opts: {
      skipPurchase?: boolean; serverId?: number; forceNewServer?: boolean
      customProvider?: string; customModel?: string
    } = {},
  ) => {
    const fd = new FormData()
    for (const id of domainIds) fd.append("domain_ids", id)
    if (opts.skipPurchase) fd.set("skip_purchase", "on")
    if (opts.serverId != null) fd.set("server_id", String(opts.serverId))
    if (opts.forceNewServer) fd.set("force_new_server", "on")
    if (opts.customProvider) fd.set("custom_provider", opts.customProvider)
    if (opts.customModel) fd.set("custom_model", opts.customModel)
    return fetch("/api/domains/run-bulk-sequential", { method: "POST", body: fd, credentials: "same-origin" })
      .then(async (r) => ({ ok: r.ok, ...((await r.json()) as Record<string, unknown>) }))
  },
  /**
   * Migrate the selected domains to a chosen target server. Each domain's
   * SA app moves; CF A-records flip to new IP; original zone / NS /
   * registrar settings are preserved. Uses the cached site archive for
   * cert + index.php redeploy, no LLM regeneration.
   */
  bulkMigrate: (
    domainIds: string[],
    opts: { targetServerId?: number; forceNewServer?: boolean } = {},
  ) => {
    const fd = new FormData()
    for (const id of domainIds) fd.append("domain_ids", id)
    if (opts.targetServerId != null) fd.set("target_server_id", String(opts.targetServerId))
    if (opts.forceNewServer) fd.set("force_new_server", "on")
    return fetch("/api/domains/bulk-migrate", { method: "POST", body: fd, credentials: "same-origin" })
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
  /**
   * Reinstall the SA agent on this server's existing DO droplet. Use when
   * the original install failed mid-script — the droplet is fine, just
   * needs the install re-run cleanly. Returns 202 + job id; poll the logs
   * for "reinstall_sa" entries. Worst-case 30 min (2 attempts × 15 min).
   */
  reinstallSa: (id: number) => postForm(`/api/servers/${id}/reinstall-sa`),
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
  /** Sync — walks every active CF key, lists zones, reconciles drift
   *  against the domains table. Auto-backfills cf_zone_id when a name
   *  match exists; reports orphans + untracked zones for operator review.
   *  dryRun=true skips the backfill writes (still surfaces the report). */
  sync: (dryRun = false) =>
    postForm("/api/cloudflare/sync", { dry_run: dryRun ? "on" : undefined }),
  /** Bulk add CF keys — CSV paste/upload OR JSON rows[]. Per-row CF /accounts
   *  verification before insert; per-row results returned in `results[]`. */
  bulkAdd: (rows: { email: string; api_key: string; alias?: string }[]) =>
    fetch("/api/cf-keys/bulk-add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ rows }),
    }).then(async (r) => ({ ok: r.ok, ...((await r.json()) as Record<string, unknown>) })),
  /** Bulk add via CSV file/text — used by the modal's CSV upload tab. */
  bulkAddCsv: (csvText: string, csvFile?: File) => {
    const fd = new FormData()
    if (csvFile) fd.set("csv_file", csvFile)
    else fd.set("csv_text", csvText)
    return fetch("/api/cf-keys/bulk-add", {
      method: "POST", body: fd, credentials: "same-origin",
    }).then(async (r) => ({ ok: r.ok, ...((await r.json()) as Record<string, unknown>) }))
  },
  /** Bulk delete — checks per-row that no domain still references the key. */
  bulkDelete: (ids: number[]) =>
    fetch("/api/cf-keys/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ids }),
    }).then(async (r) => ({ ok: r.ok, ...((await r.json()) as Record<string, unknown>) })),
  /** Bulk edit selected keys: any combo of max_domains, is_active, alias_pattern. */
  bulkEdit: (
    ids: number[],
    fields: { max_domains?: number; is_active?: 0 | 1; alias_pattern?: string; alias_start?: number },
  ) =>
    fetch("/api/cf-keys/bulk-edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ids, ...fields }),
    }).then(async (r) => ({ ok: r.ok, ...((await r.json()) as Record<string, unknown>) })),
  /** Probe domains under selected keys and flip status decisively. Persists last_error on failures. */
  bulkRefreshStatus: (ids: number[]) =>
    fetch("/api/cf-keys/bulk-refresh-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ids }),
    }).then(async (r) => ({ ok: r.ok, ...((await r.json()) as Record<string, unknown>) })),
  /** Re-fetch CF /accounts for selected keys; persists last_error on failures. */
  bulkVerifyAccounts: (ids: number[]) =>
    fetch("/api/cf-keys/bulk-verify-accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ids }),
    }).then(async (r) => ({ ok: r.ok, ...((await r.json()) as Record<string, unknown>) })),
  /** Diagnostic — create a throwaway zone with this key and immediately delete
   *  it. Confirms the (email, api_key, cf_account_id) triple can mint zones. */
  testCreateZone: (id: number) => postForm(`/api/cf-keys/${id}/test-create-zone`),
  /** List zones CF reports for this key's account — surfaces orphans (zones
   *  in CF that SSR doesn't track) and missing zones (SSR rows with cf_zone_id
   *  that CF no longer has). */
  listZones: (id: number) => getJson(`/api/cf-keys/${id}/zones`),
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
