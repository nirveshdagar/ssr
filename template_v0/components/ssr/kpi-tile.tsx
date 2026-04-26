import * as React from "react"
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

interface KpiTileProps {
  label: string
  value: string | number
  change?: { value: string; direction: "up" | "down" | "flat"; positive?: boolean }
  icon: LucideIcon
  hint?: string
  accent?: "default" | "primary" | "info" | "success" | "warning" | "danger"
}

const ACCENT_STYLES: Record<
  NonNullable<KpiTileProps["accent"]>,
  { chip: string; rail: string }
> = {
  default: {
    chip: "bg-muted text-muted-foreground",
    rail: "bg-border",
  },
  primary: {
    chip: "bg-[color:color-mix(in_oklch,var(--primary)_14%,transparent)] text-primary",
    rail: "bg-primary",
  },
  info: {
    chip: "bg-[color:color-mix(in_oklch,var(--info)_14%,transparent)] text-[color:var(--info)]",
    rail: "bg-[color:var(--info)]",
  },
  success: {
    chip: "bg-[color:color-mix(in_oklch,var(--success)_14%,transparent)] text-[color:var(--success)]",
    rail: "bg-[color:var(--success)]",
  },
  warning: {
    chip: "bg-[color:color-mix(in_oklch,var(--warning)_18%,transparent)] text-[color:color-mix(in_oklch,var(--warning)_70%,var(--foreground))]",
    rail: "bg-[color:var(--warning)]",
  },
  danger: {
    chip: "bg-[color:color-mix(in_oklch,var(--destructive)_14%,transparent)] text-destructive",
    rail: "bg-destructive",
  },
}

export function KpiTile({ label, value, change, icon: Icon, hint, accent = "default" }: KpiTileProps) {
  const styles = ACCENT_STYLES[accent]

  return (
    <div className="relative overflow-hidden rounded-md border border-border bg-card p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      {/* Left rail in accent color */}
      <span className={cn("absolute inset-y-0 left-0 w-0.5", styles.rail)} aria-hidden />
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-micro font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
          <span className="text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
        </div>
        <div className={cn("flex h-7 w-7 items-center justify-center rounded-md", styles.chip)}>
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-micro">
        {change ? (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 font-medium tabular-nums",
              change.positive ? "text-status-completed" : "text-status-terminal",
              change.direction === "flat" && "text-muted-foreground",
            )}
          >
            {change.direction === "up" && <ArrowUpRight className="h-3 w-3" aria-hidden />}
            {change.direction === "down" && <ArrowDownRight className="h-3 w-3" aria-hidden />}
            {change.value}
          </span>
        ) : (
          <span className="text-muted-foreground">&nbsp;</span>
        )}
        {hint && <span className="truncate text-muted-foreground">{hint}</span>}
      </div>
    </div>
  )
}
