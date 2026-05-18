/**
 * Step-10 post-upload verification — PURE core (no I/O, unit-tested).
 *
 * Bug the operator caught: step 10 marked a domain `hosted` whenever the
 * SA file-manager API returned 2xx OR the SFTP write didn't throw — it
 * NEVER read the file back. So a write that "succeeded" per the API but
 * never landed in the path Apache actually serves (app dir never
 * scaffolded; SFTP wrote to a non-served public_html) silently passed as
 * hosted with no index.php.
 *
 * Verification rule (deliberately asymmetric — never regress a real
 * success): only a DEFINITIVE "served docroot exists but index.php is
 * missing/empty" fails step 10. "No resolvable served vhost" (NODR) is a
 * vhost/SSL problem owned by the vhost-guard / SSL sweeps, not an upload
 * failure, so it's inconclusive → warn + proceed. SSH/parse failure is
 * also inconclusive.
 */

/** Build the read-only remote probe for a domain's served entry file. */
export function buildEntryProbeScript(domain: string): string {
  const esc = domain.replace(/[.\\]/g, "\\$&") // escape regex metachars
  return [
    'dr=""',
    "for f in /etc/apache2/sites-enabled/*.conf; do",
    `  if grep -qiE "^[[:space:]]*ServerName[[:space:]]+${esc}([[:space:]]|$)" "$f" 2>/dev/null; then`,
    `    dr=$(grep -oP "^\\s*DocumentRoot\\s+\\K\\S+" "$f" 2>/dev/null | head -1)`,
    '    [ -n "$dr" ] && break',
    "  fi",
    "done",
    'if [ -z "$dr" ]; then echo "RESULT|NODR||"; ',
    'elif [ -s "$dr/index.php" ]; then echo "RESULT|OK|$(stat -c%s "$dr/index.php" 2>/dev/null)|$dr"; ',
    'elif [ -f "$dr/index.php" ]; then echo "RESULT|EMPTY|0|$dr"; ',
    'else echo "RESULT|MISSING||$dr"; fi',
  ].join("\n")
}

export interface EntryVerdict {
  verdict: "ok" | "missing" | "inconclusive"
  detail: string
}

/** Classify the probe output. */
export function classifyEntryVerify(raw: string): EntryVerdict {
  const line = String(raw).split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("RESULT|"))
  if (!line) return { verdict: "inconclusive", detail: "no RESULT line from probe (ssh/parse issue)" }
  const [, state, bytes, dr] = line.split("|")
  switch (state) {
    case "OK": {
      const n = Number(bytes)
      if (Number.isFinite(n) && n > 0) return { verdict: "ok", detail: `served ${dr}/index.php (${n} bytes)` }
      return { verdict: "missing", detail: `served ${dr}/index.php reports OK but ${bytes} bytes` }
    }
    case "EMPTY":
      return { verdict: "missing", detail: `served ${dr}/index.php exists but is EMPTY (0 bytes)` }
    case "MISSING":
      return { verdict: "missing", detail: `served docroot ${dr} has NO index.php` }
    case "NODR":
      return { verdict: "inconclusive", detail: "no enabled vhost serves this domain (vhost/SSL problem, not upload) — not failing step 10" }
    default:
      return { verdict: "inconclusive", detail: `unrecognized probe state '${state}'` }
  }
}

/**
 * Standing auto-heal decision for a domain that's marked hosted/live but
 * whose entry file we just verified. Mirrors checkOriginCerts' cap logic:
 * only a DEFINITIVE miss acts; cap prevents infinite re-upload loops when
 * the real cause is upstream (app dir never scaffolded → step 10 will
 * fail retryable anyway); inflight avoids stacking jobs.
 */
export function decideEntryHeal(opts: {
  verdict: EntryVerdict["verdict"]
  recentFailures: number  // audit 'entry_file_missing' for this domain in last 60min
  maxPerHour: number
  inflight: boolean       // a pipeline.full already queued/running for this domain
}): "act" | "skip" | "giveup" {
  if (opts.verdict !== "missing") return "skip" // ok / inconclusive → never act
  if (opts.recentFailures >= opts.maxPerHour) return "giveup"
  if (opts.inflight) return "skip"
  return "act"
}
