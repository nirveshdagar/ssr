"use client"

import * as React from "react"
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react"
import { usePreflight } from "@/hooks/use-preflight"
import { cn } from "@/lib/utils"

// Human labels for runAll()'s check keys.
const LABELS: Record<string, string> = {
  cf_pool: "Cloudflare key pool",
  do_token: "DigitalOcean token",
  sa_auth: "ServerAvatar auth",
  spaceship_auth: "Spaceship + registrant",
  llm_key: "LLM provider key",
  server_capacity: "Server capacity",
  root_password: "Server root password",
  ssl_ui_fallback: "SSL UI fallback",
}

/**
 * Environment config health, front and centre on the dashboard. Quiet
 * one-liner when everything's green; a loud red panel listing exactly
 * what's broken when not — so a misconfigured environment (the
 * separate-DB Spaceship/registrant gap that cost days) is obvious at a
 * glance instead of only surfacing when a pipeline fails.
 */
export function ConfigHealthBanner() {
  const { report, error, isLoading, refresh } = usePreflight()

  if (isLoading && !report) {
    return (
      <div className="rounded-md border border-border bg-card px-4 py-2.5 text-small text-muted-foreground">
        Checking environment config…
      </div>
    )
  }
  if (error || !report) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-status-waiting/40 bg-status-waiting/10 px-4 py-2.5 text-small">
        <span className="text-status-waiting">Couldn’t run config health check.</span>
        <button onClick={() => refresh()} className="inline-flex items-center gap-1 text-micro text-muted-foreground hover:text-foreground">
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  const failing = Object.entries(report.checks).filter(([, c]) => !c.ok)

  if (report.ok) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-4 py-2 text-small">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 text-status-completed" />
          Environment config OK ({Object.keys(report.checks).length} checks)
        </span>
        <button onClick={() => refresh()} className="inline-flex items-center gap-1 text-micro text-muted-foreground hover:text-foreground">
          <RefreshCw className="h-3 w-3" /> Recheck
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-status-terminal/50 bg-status-terminal/10 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-status-terminal">
          <AlertTriangle className="h-4 w-4" />
          Environment config problem — {failing.length} of {Object.keys(report.checks).length} checks failing
        </span>
        <button onClick={() => refresh()} className="inline-flex items-center gap-1 text-micro text-muted-foreground hover:text-foreground">
          <RefreshCw className="h-3 w-3" /> Recheck
        </button>
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {failing.map(([key, c]) => (
          <li key={key} className={cn("text-small")}>
            <span className="font-medium">{LABELS[key] ?? key}:</span>{" "}
            <span className="text-muted-foreground">{c.message}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-micro text-muted-foreground">
        Fix these in Settings. Each environment has its own DB — config set on
        local does not exist on prod (and vice-versa).
      </p>
    </div>
  )
}
