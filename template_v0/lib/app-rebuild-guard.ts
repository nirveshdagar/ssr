/**
 * SA-app rebuild escalation — PURE decision core (no I/O, unit-tested).
 *
 * The last manual loop: when SA's partial-create left a domain with NO app
 * directory (or no SA app record at all), no amount of SSL re-install or
 * entry-file re-upload can fix it — the app must be torn down + recreated
 * so SA scaffolds dir + php-fpm pool + vhost (done by hand for conceptden
 * this session). This decides when to do that automatically.
 *
 * DESTRUCTIVE (deletes an SA app record + full pipeline re-run) → only
 * fires as an ESCALATION after the cheaper heals (SSL self-heal,
 * entry-file re-upload) have already given up, and only on a POSITIVE
 * "not scaffolded" determination. Any ambiguity / unknown → skip.
 */

export type AppScaffoldState =
  | "scaffolded"     // SA app exists AND its app dir exists on the box → fine
  | "no-sa-app"      // SA has no app for this domain → recreate
  | "sa-app-no-dir"  // SA app record exists but its dir was never made → teardown+recreate
  | "unknown"        // couldn't determine (SA/SSH error) → never act

export function decideAppRebuild(opts: {
  state: AppScaffoldState
  recentRebuilds: number   // audit 'app_rebuild' for this domain in last 24h
  maxPerDay: number
  inflight: boolean        // a pipeline.full already queued/running for it
}): "rebuild" | "giveup" | "skip" {
  if (opts.state === "scaffolded" || opts.state === "unknown") return "skip"
  if (opts.inflight) return "skip"          // don't stack a rebuild
  if (opts.recentRebuilds >= opts.maxPerDay) return "giveup" // SA itself broken → human
  return "rebuild"                          // no-sa-app | sa-app-no-dir
}

/** Does the SA app record need deleting before recreate? Only when a
 *  stale record exists (sa-app-no-dir); for no-sa-app there's nothing to
 *  delete and step 7 will create fresh. */
export function rebuildNeedsSaDelete(state: AppScaffoldState): boolean {
  return state === "sa-app-no-dir"
}
