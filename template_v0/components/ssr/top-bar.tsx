"use client"

import * as React from "react"
import { useTheme } from "next-themes"
import { Moon, Sun, Search, Command, Bell, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Detect whether we're running in production. The Node side tags `NODE_ENV`
 * as a build-time `NEXT_PUBLIC_NODE_ENV` (set in next.config) OR we infer
 * from the host: localhost / 127.0.0.1 / 0.0.0.0 / *.local → LOCAL, else PROD.
 *
 * Mirrors Flask base.html semantics: LOCAL is green, PROD is red — flagging
 * production at a glance so an operator doesn't accidentally run destructive
 * commands on the wrong dashboard.
 */
function detectEnv(): "LOCAL" | "PROD" {
  if (typeof window === "undefined") return "PROD"
  const h = window.location.hostname
  if (
    h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" ||
    h.endsWith(".local") || h.endsWith(".localhost") ||
    /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  ) return "LOCAL"
  return "PROD"
}

type Accent =
  | "dashboard"
  | "domains"
  | "servers"
  | "cloudflare"
  | "watcher"
  | "logs"
  | "audit"
  | "settings"
  | "sa"

interface TopBarProps {
  title: string
  description?: string
  breadcrumbs?: { label: string; href?: string }[]
  actions?: React.ReactNode
  accent?: Accent
}

const ACCENT_CLASS: Record<Accent, string> = {
  dashboard: "accent-dashboard",
  domains: "accent-domains",
  servers: "accent-servers",
  cloudflare: "accent-cloudflare",
  watcher: "accent-watcher",
  logs: "accent-logs",
  audit: "accent-audit",
  settings: "accent-settings",
  sa: "accent-sa",
}

export function TopBar({ title, description, breadcrumbs, actions, accent }: TopBarProps) {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
  const [env, setEnv] = React.useState<"LOCAL" | "PROD">("PROD")
  React.useEffect(() => { setMounted(true); setEnv(detectEnv()) }, [])
  const accentVar = accent ? `var(--page-${accent})` : undefined

  return (
    <header
      className={cn(
        "page-accent sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70",
        accent && ACCENT_CLASS[accent],
      )}
    >
      {/* 2px accent strip — matches Flask base.html ::before. The color
          tracks the per-page accent so each section is visually distinct. */}
      {accentVar && (
        <div
          className="h-[2px] w-full"
          style={{ backgroundColor: accentVar }}
          aria-hidden
        />
      )}
      <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {breadcrumbs && breadcrumbs.length > 0 ? (
            <nav aria-label="Breadcrumb" className="hidden sm:flex items-center gap-1.5 text-small text-muted-foreground">
              {breadcrumbs.map((crumb, i) => (
                <React.Fragment key={`${crumb.label}-${i}`}>
                  {i > 0 && <ChevronRight className="h-3 w-3 opacity-50" aria-hidden />}
                  <span className={cn(i === breadcrumbs.length - 1 && "text-foreground font-medium")}>{crumb.label}</span>
                </React.Fragment>
              ))}
            </nav>
          ) : (
            <div className="flex flex-col leading-tight min-w-0">
              <h1 className="truncate text-[14px] font-semibold tracking-tight">{title}</h1>
              {description && <p className="truncate text-micro text-muted-foreground">{description}</p>}
            </div>
          )}
        </div>

        {/* Center search — opens the global command palette (⌘K). The
            keyboard shortcut is handled inside <CommandPalette/> directly;
            this button just dispatches a custom event so a click reaches the
            same UI without prop-drilling state through the whole shell. */}
        <div className="hidden lg:flex flex-1 max-w-md justify-center">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event("ssr:open-palette"))}
            title="Open the command palette — search domains, servers, CF keys + run actions"
            className="group flex h-8 w-full items-center gap-2 rounded-md border border-input bg-card px-2.5 text-small text-muted-foreground transition-colors hover:border-ring/40"
          >
            <Search className="h-3.5 w-3.5" aria-hidden />
            <span className="flex-1 text-left">Jump to domain, server, log…</span>
            <kbd className="inline-flex h-5 select-none items-center gap-1 rounded border border-border bg-muted px-1 text-micro font-medium text-muted-foreground">
              <Command className="h-2.5 w-2.5" aria-hidden />K
            </kbd>
          </button>
        </div>

        <div className="flex items-center gap-2">
          {/* Env badge — green for LOCAL, red for PROD. Detected from the
              browser's hostname; flags accidental clicks on the wrong env. */}
          {mounted && (
            <span
              className={cn(
                "hidden sm:inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-micro font-medium tabular-nums",
                env === "LOCAL"
                  ? "border-[color:color-mix(in_oklch,var(--success)_30%,transparent)] bg-[color:color-mix(in_oklch,var(--success)_10%,transparent)] text-[color:var(--success)]"
                  : "border-[color:color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-[color:color-mix(in_oklch,var(--destructive)_10%,transparent)] text-[color:var(--destructive)]",
              )}
              title={`Current environment: ${env === "LOCAL" ? "local development" : "production"}`}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full animate-status-pulse",
                  env === "LOCAL" ? "bg-[color:var(--success)]" : "bg-destructive",
                )}
                aria-hidden
              />
              <span className="font-mono uppercase tracking-wider">{env}</span>
            </span>
          )}

          {actions}

          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Notifications">
            <Bell className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Toggle theme"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          >
            {mounted && resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Page title row (desktop) */}
      {breadcrumbs && (
        <div className="border-t border-border/60 px-4 lg:px-6 py-3">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
              {description && <p className="mt-0.5 text-small text-muted-foreground">{description}</p>}
            </div>
          </div>
        </div>
      )}
    </header>
  )
}
