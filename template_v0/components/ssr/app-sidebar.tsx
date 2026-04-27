"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { NAV_ITEMS } from "@/lib/ssr/nav"
import { useStatus } from "@/hooks/use-status"
import { Server } from "lucide-react"

export function AppSidebar() {
  const pathname = usePathname()
  const { status } = useStatus(5000)
  const counts = status?.counts

  return (
    <aside
      aria-label="Primary"
      className="hidden md:flex md:w-[220px] lg:w-[240px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar"
    >
      {/* Brand */}
      <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Server className="h-4 w-4" aria-hidden />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-[13px] font-semibold tracking-tight text-sidebar-foreground">SSR</span>
          <span className="text-micro text-muted-foreground">Site Server Rotation</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-2" aria-label="Sections">
        <ul className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
            const Icon = item.icon
            const accentVar = `var(--page-${item.accent})`
            // Resolve runtime badge from the live status response.
            const badgeValue = item.badgeKey
              ? (counts ? counts[item.badgeKey] : undefined)
              : item.badge
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "group relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  {active && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r"
                      style={{ backgroundColor: accentVar }}
                    />
                  )}
                  <Icon
                    aria-hidden
                    className={cn("h-4 w-4 shrink-0 transition-colors", !active && "text-muted-foreground group-hover:opacity-90")}
                    style={active ? { color: accentVar } : undefined}
                  />
                  <span className="flex-1 truncate">{item.label}</span>
                  {badgeValue !== undefined && (
                    <span
                      className={cn(
                        "ml-auto rounded px-1.5 py-px text-micro font-medium tabular-nums",
                        active
                          ? "bg-background text-foreground"
                          : "bg-muted text-muted-foreground group-hover:bg-background",
                      )}
                    >
                      {badgeValue}
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>

        <div className="mt-6 px-2.5">
          <div className="text-micro font-medium uppercase tracking-wider text-muted-foreground/70">Queue</div>
          <div className="mt-2 flex items-center justify-between rounded-md border border-sidebar-border bg-card px-2.5 py-2">
            <div className="flex flex-col">
              <span className="text-micro text-muted-foreground">Active jobs</span>
              <span className="text-[13px] font-semibold tabular-nums">{counts?.active_jobs ?? "—"}</span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-micro text-muted-foreground">Queued</span>
              <span className="text-[13px] font-semibold tabular-nums">{counts?.queued_jobs ?? "—"}</span>
            </div>
          </div>
        </div>
      </nav>

      {/* Footer */}
      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
            OP
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-[12px] font-medium">operator</span>
            <span className="text-micro text-muted-foreground">Single user</span>
          </div>
        </div>
      </div>
    </aside>
  )
}
