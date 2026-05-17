/**
 * Apache vhost blast-radius guard — PURE decision core (no I/O, unit-tested).
 *
 * Context: a single partially-created SA site writes an Apache vhost whose
 * DocumentRoot AND error-log directory don't exist. A missing error-log dir
 * is FATAL to `apache2ctl configtest` (AH00014), so apache refuses to start
 * AT ALL — one bad site takes down EVERY site on the droplet (9h outage,
 * 2026-05-17). `5df30c8` stops the partial-create source; this guard bounds
 * the blast radius: detect the broken vhost, quarantine ONLY it, reload.
 *
 * This module decides WHAT to quarantine from a read-only probe. The SSH
 * execution lives in sa-control.ts; the unattended sweep in auto-heal.ts.
 */

export interface VhostEntry {
  /** Absolute path of the enabled .conf */
  conf: string
  documentRoot: string
  documentRootExists: boolean
  /** dirname(ErrorLog) — the directory apache needs to open the log */
  errorLogDir: string
  errorLogDirExists: boolean
}

export interface VhostProbe {
  /** true when `apache2ctl configtest` returned Syntax OK (rc 0) */
  configtestOk: boolean
  /** trimmed configtest output (for logs) */
  configtestMsg: string
  vhosts: VhostEntry[]
}

export interface QuarantineDecision {
  /** Confs that are PROVABLY broken (missing docroot or error-log dir). */
  quarantine: { conf: string; reasons: string[] }[]
  /**
   * Whether the sweep should actually act. True only when apache config is
   * CURRENTLY broken AND every broken conf is provably broken AND parking
   * them is plausibly the fix (≥1 broken conf found). If configtest fails
   * but NO conf has a missing dir, the failure is something else we must
   * NOT touch — return act=false so a human looks.
   */
  act: boolean
  reason: string
}

/**
 * Parse the output of the read-only remote probe script (see
 * sa-control.ts → quarantineBrokenVhosts). Format, line-based:
 *   CONFIGTEST_START
 *   <apache2ctl configtest output…>
 *   CONFIGTEST_END rc=<n>
 *   VHOST|<conf>|dr=<path>|drx=<Y|N>|eld=<dir>|elx=<Y|N>
 */
export function parseVhostProbe(raw: string): VhostProbe {
  const lines = String(raw).split(/\r?\n/)
  let inCt = false
  const ctLines: string[] = []
  let rc: number | null = null
  const vhosts: VhostEntry[] = []
  for (const ln of lines) {
    if (ln.startsWith("CONFIGTEST_START")) { inCt = true; continue }
    if (ln.startsWith("CONFIGTEST_END")) {
      inCt = false
      const m = ln.match(/rc=(-?\d+)/)
      rc = m ? Number(m[1]) : null
      continue
    }
    if (inCt) { ctLines.push(ln); continue }
    if (ln.startsWith("VHOST|")) {
      const parts = ln.split("|")
      // VHOST | conf | dr=… | drx=Y/N | eld=… | elx=Y/N
      const get = (p: string, k: string) => p.startsWith(k + "=") ? p.slice(k.length + 1) : null
      const conf = parts[1] ?? ""
      let documentRoot = "", errorLogDir = "", drx = "N", elx = "N"
      for (const p of parts.slice(2)) {
        documentRoot = get(p, "dr") ?? documentRoot
        errorLogDir = get(p, "eld") ?? errorLogDir
        drx = get(p, "drx") ?? drx
        elx = get(p, "elx") ?? elx
      }
      if (conf) {
        vhosts.push({
          conf,
          documentRoot,
          documentRootExists: drx === "Y",
          errorLogDir,
          errorLogDirExists: elx === "Y",
        })
      }
    }
  }
  const ctMsg = ctLines.join("\n").trim()
  // configtest is OK when rc==0, OR (rc unknown) the text says "Syntax OK"
  // and carries no fatal AH00014. AH00558 (ServerName) is a warning only.
  const configtestOk = rc === 0
    || (rc === null && /Syntax OK/.test(ctMsg) && !/AH00014/.test(ctMsg))
  return { configtestOk, configtestMsg: ctMsg, vhosts }
}

/** A vhost is provably broken iff its docroot OR its error-log dir is gone. */
export function brokenReasons(v: VhostEntry): string[] {
  const r: string[] = []
  if (!v.documentRootExists) r.push(`DocumentRoot missing: ${v.documentRoot || "(none)"}`)
  if (!v.errorLogDirExists) r.push(`ErrorLog dir missing: ${v.errorLogDir || "(none)"}`)
  return r
}

/**
 * Decide whether to quarantine and which confs. Conservative by design —
 * acts ONLY when config is currently broken AND the breakage is fully
 * explained by provably-missing dirs (so parking those confs fixes it).
 */
export function decideQuarantine(probe: VhostProbe): QuarantineDecision {
  if (probe.configtestOk) {
    return { quarantine: [], act: false, reason: "apache config is healthy (Syntax OK) — nothing to do" }
  }
  const quarantine = probe.vhosts
    .map((v) => ({ conf: v.conf, reasons: brokenReasons(v) }))
    .filter((x) => x.reasons.length > 0)
  if (quarantine.length === 0) {
    return {
      quarantine: [],
      act: false,
      reason: "configtest FAILS but no enabled vhost has a missing DocumentRoot/" +
        "ErrorLog dir — cause is something else; NOT touching config (needs a human)",
    }
  }
  return {
    quarantine,
    act: true,
    reason: `configtest FAILS and ${quarantine.length} vhost(s) have a ` +
      `provably-missing dir — quarantining only those, then reloading apache`,
  }
}

/** Map an enabled conf path → the domain it serves (for status flagging). */
export function confToDomain(conf: string): string | null {
  // SA confs are `<app-name>-site[-le]-ssl.conf` / `<app-name>-site.conf`
  // where app-name derives from the domain. Best-effort: strip dir + the
  // SA suffixes; callers reconcile against the domains table.
  const base = conf.replace(/^.*\//, "").replace(/\.conf$/, "")
  const m = base.replace(/-le-ssl$|-ssl$/i, "").replace(/-site$/i, "")
  return m || null
}
