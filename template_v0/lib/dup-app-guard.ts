/**
 * Duplicate SA-application cleanup — PURE decision core (no I/O, unit-tested).
 *
 * Repeated step-7 createApplication across re-runs (before the proactive
 * dup-guard) left multiple SA *application records* for the same domain on
 * a server. This decides which redundant records are SAFE to delete.
 *
 * DESTRUCTIVE — so the rule is maximally conservative: for a domain with
 * ≥2 SA apps, act ONLY when EXACTLY ONE app's document root provably
 * EXISTS-and-is-non-empty (the real serving install = the keeper) AND
 * EVERY other app's document root provably does NOT exist (a dead
 * partial-create record that cannot be serving anything). Any ambiguity
 * — unknown doc root, ≥2 real installs, zero real installs — SKIPS the
 * whole group and asks for a human. We never delete the keeper, never the
 * only app, never on uncertainty.
 */

export interface DupApp {
  id: string
  /** SA primary_domain (may be undefined on malformed records) */
  primaryDomain?: string
  /** SA app name (e.g. "conceptden-site") */
  name?: string
  /** best-effort document root extracted from the loose SA app object */
  docRoot: string | null
}

/** true = dir exists & non-empty, false = provably absent, undefined = unknown */
export type DirState = (docRoot: string) => boolean | undefined

export interface DupGroupDecision {
  domain: string
  keep: string | null
  delete: string[]
  act: boolean
  reason: string
}

/** domain → its SA app-name (mirror of serveravatar.appNameFor, kept pure) */
export function appNameForDomain(domain: string): string {
  return domain.replace(/\./g, "-").replace(/_/g, "-")
}

/** Pull a document root out of a loose SA app object, defensively. */
export function extractDocRoot(app: Record<string, unknown>): string | null {
  for (const k of ["document_root", "app_path", "path", "public_path", "document_root_path"]) {
    const v = app[k]
    if (typeof v === "string" && v.trim().startsWith("/")) return v.trim()
  }
  return null
}

/** Which domain (from the known set) does this app belong to? */
export function appDomain(app: DupApp, knownDomains: string[]): string | null {
  const pd = (app.primaryDomain || "").toLowerCase()
  const nm = (app.name || "").toLowerCase()
  for (const d of knownDomains) {
    const dl = d.toLowerCase()
    if (pd === dl) return d
    if (nm === appNameForDomain(dl)) return d
    if (pd.endsWith("." + dl) || pd === "www." + dl) return d
  }
  return null
}

export function decideDuplicateCleanup(
  apps: DupApp[],
  knownDomains: string[],
  dirState: DirState,
): DupGroupDecision[] {
  // Group by domain.
  const byDomain = new Map<string, DupApp[]>()
  for (const a of apps) {
    const d = appDomain(a, knownDomains)
    if (!d) continue
    const arr = byDomain.get(d) ?? []
    arr.push(a)
    byDomain.set(d, arr)
  }

  const out: DupGroupDecision[] = []
  for (const [domain, group] of byDomain) {
    if (group.length < 2) continue // not a duplicate set

    // Any app whose doc root we can't even determine → too risky, skip all.
    if (group.some((a) => !a.docRoot)) {
      out.push({ domain, keep: null, delete: [], act: false,
        reason: `${group.length} SA apps but ≥1 has no resolvable document root — NOT touching (needs a human)` })
      continue
    }
    const withState = group.map((a) => ({ a, exists: dirState(a.docRoot as string) }))
    if (withState.some((x) => x.exists === undefined)) {
      out.push({ domain, keep: null, delete: [], act: false,
        reason: `dir existence unknown for ≥1 of ${group.length} apps — NOT touching (needs a human)` })
      continue
    }
    const real = withState.filter((x) => x.exists === true)
    const empty = withState.filter((x) => x.exists === false)
    if (real.length === 1 && empty.length === group.length - 1) {
      out.push({
        domain,
        keep: real[0].a.id,
        delete: empty.map((x) => x.a.id),
        act: true,
        reason: `1 serving install (keep ${real[0].a.id}); ${empty.length} dead ` +
          `partial-create record(s) with no files — safe to delete`,
      })
    } else {
      out.push({ domain, keep: null, delete: [], act: false,
        reason: `ambiguous — ${real.length} serving + ${empty.length} empty of ` +
          `${group.length} (need exactly 1 serving + rest empty); needs a human` })
    }
  }
  return out
}
