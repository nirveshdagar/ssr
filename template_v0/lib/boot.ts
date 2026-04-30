/**
 * Boot resilience hooks — Node port of the two daemon threads in app.py:
 *
 *  greyCloudRecovery: scans every domain in status hosted/live/ssl_installed,
 *    finds proxied=false A records (which expose the origin IP — usually
 *    leftover from a step-8 grey-cloud that crashed before restoring the
 *    orange cloud), and re-enables the proxy. Idempotent.
 *
 *  orphanDropletSweep: lists every DO droplet tagged 'ssr-server' and
 *    compares against the servers table. Anything on DO with no matching
 *    DB row is reported (NOT auto-destroyed — too dangerous; the operator
 *    might have spun one up by hand).
 *
 * Both run on a delay after boot so init + DO test have time to settle.
 */

import { listDomains } from "./repos/domains"
import { listServers } from "./repos/servers"
import { logPipeline } from "./repos/logs"

// ---------------------------------------------------------------------------
// Grey-cloud recovery
// ---------------------------------------------------------------------------

interface CfDnsRecord {
  id: string
  type: string
  name: string
  content: string
  proxied?: boolean
}

async function recoverGreyCloudOnce(): Promise<void> {
  const cfApi = "https://api.cloudflare.com/client/v4"
  let restored = 0
  for (const d of listDomains()) {
    if (d.status !== "hosted" && d.status !== "live" && d.status !== "ssl_installed") continue
    if (!d.cf_zone_id || !d.cf_email || !d.cf_global_key) continue
    const headers = {
      "X-Auth-Email": d.cf_email,
      "X-Auth-Key": d.cf_global_key,
      "Content-Type": "application/json",
    }
    try {
      const r = await fetch(
        `${cfApi}/zones/${d.cf_zone_id}/dns_records?type=A`,
        { headers, signal: AbortSignal.timeout(20_000) },
      )
      if (!r.ok) continue
      const j = (await r.json()) as { result?: CfDnsRecord[] }
      for (const rec of j.result ?? []) {
        if (rec.proxied !== false) continue
        const patch = await fetch(
          `${cfApi}/zones/${d.cf_zone_id}/dns_records/${rec.id}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ proxied: true }),
            signal: AbortSignal.timeout(20_000),
          },
        )
        if (patch.ok) {
          restored++
          logPipeline(d.domain, "grey_cloud_recovery", "completed",
            `Re-enabled proxy on record ${rec.name} (was grey — origin was exposed)`)
        }
      }
    } catch (e) {
      logPipeline(d.domain, "grey_cloud_recovery", "warning",
        `recovery check failed: ${(e as Error).message}`)
    }
  }
  if (restored > 0) {
    logPipeline("(startup)", "grey_cloud_recovery", "completed",
      `Restored orange-cloud on ${restored} A-record(s) after a prior process kill left them exposed.`)
  }
}

// ---------------------------------------------------------------------------
// Orphan droplet sweep
// ---------------------------------------------------------------------------

async function orphanDropletSweepOnce(): Promise<void> {
  try {
    const { listDroplets } = await import("./digitalocean")
    const dropplets = await listDroplets({ tag: "ssr-server" })
    const known = new Set<string>(
      listServers().map((s) => s.do_droplet_id).filter((x): x is string => Boolean(x)),
    )
    const orphans = dropplets.filter((d) => !known.has(String(d.id)))
    if (orphans.length === 0) return

    const lines = orphans.map((d) => {
      const v4 = d.networks?.v4 ?? []
      const ip = v4.find((n) => n.type === "public")?.ip_address ?? "?"
      return `#${d.id} (${d.name ?? "?"} / ${ip})`
    })
    const msg =
      `Found ${orphans.length} orphan DO droplet(s) tagged 'ssr-server' with NO matching servers row:\n  ` +
      lines.join("\n  ") +
      "\n\nThese are likely leftover from a crashed step-6 provision. " +
      "Verify manually and destroy from DO console if not needed (they're being billed)."
    logPipeline("(startup)", "orphan_droplets", "warning", msg)
    try {
      const { notify } = await import("./notify")
      await notify("Orphan DO droplets detected", msg, {
        severity: "warning", dedupeKey: "orphan_droplets_boot",
      })
    } catch { /* notify is best-effort */ }
  } catch (e) {
    logPipeline("(startup)", "orphan_droplets", "warning",
      `sweep failed: ${(e as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// Public scheduler — fire both with delays, fire-and-forget
// ---------------------------------------------------------------------------

// HMR-safe boot guard: dev-mode module re-evaluation would otherwise let
// these one-shot sweeps fire repeatedly per edit.
declare global {
  // eslint-disable-next-line no-var
  var __ssrBooted: boolean | undefined
}

export function scheduleBootHooks(): void {
  if (globalThis.__ssrBooted) return
  globalThis.__ssrBooted = true
  // Same delays Flask uses (5s + 8s) so init + connection pool + first
  // settings reads have settled before we hit external APIs.
  setTimeout(() => { void recoverGreyCloudOnce() }, 5000).unref?.()
  setTimeout(() => { void orphanDropletSweepOnce() }, 8000).unref?.()
  // One-shot encrypt-at-rest migration for the CF Workers AI pool. Plaintext
  // tokens written before secrets-vault coverage was extended to this table
  // get re-saved as Fernet ciphertexts; idempotent on already-encrypted rows.
  setTimeout(() => {
    try {
      void import("./repos/cf-ai-keys").then(({ encryptExistingAiTokens }) => {
        const { converted } = encryptExistingAiTokens()
        if (converted > 0) {
          logPipeline("(startup)", "secrets_vault", "completed",
            `Encrypted ${converted} legacy plaintext CF Workers AI token(s) at rest.`)
        }
      })
    } catch { /* boot is best-effort */ }
  }, 3000).unref?.()
  // Same one-shot migration for the CF DNS Global Keys pool (cf_keys table).
  setTimeout(() => {
    try {
      void import("./repos/cf-keys").then(({ encryptExistingCfKeys }) => {
        const { converted } = encryptExistingCfKeys()
        if (converted > 0) {
          logPipeline("(startup)", "secrets_vault", "completed",
            `Encrypted ${converted} legacy plaintext CF Global Key(s) at rest.`)
        }
      })
    } catch { /* boot is best-effort */ }
  }, 3500).unref?.()
  // Daily DB + Fernet-key backup. Self-skips in tests and when SSR_BACKUPS=0.
  void import("./backup").then(({ startDailyBackup }) => startDailyBackup()).catch(() => {
    /* boot is best-effort */
  })
  // Auto-heal sweeper — reconcile SA orphans + auto-resume stuck pipelines
  // every SSR_AUTOHEAL_INTERVAL_MS (default 5 min). Self-skips in tests
  // and when SSR_AUTOHEAL=0.
  void import("./auto-heal").then(({ startAutoHeal }) => startAutoHeal()).catch(() => {
    /* boot is best-effort — never wedge the server */
  })
  // Live-checker — opt-in via SSR_LIVE_CHECKER=1. OFF by default because
  // Flask runs its own; running both against the same SQLite DB causes
  // status thrash (both apps' streak counters race to flip the row).
  // Skip in test mode so vitest doesn't spawn the loop.
  if (process.env.SSR_LIVE_CHECKER === "1" && process.env.NODE_ENV !== "test") {
    void import("./live-checker").then(({ start }) => {
      start()
      logPipeline("(live-checker)", "live_check", "running",
        "Live-checker started (SSR_LIVE_CHECKER=1)")
    }).catch((e) => {
      logPipeline("(live-checker)", "live_check", "warning",
        `Live-checker failed to start: ${(e as Error).message}`)
    })
  }
}

// Exported for tests
export const _internal = { recoverGreyCloudOnce, orphanDropletSweepOnce }
