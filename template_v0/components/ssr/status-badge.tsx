import { cn } from "@/lib/utils"
import type { PipelineStatus } from "@/lib/ssr/mock-data"

type StatusKey = PipelineStatus | "healthy" | "warning" | "exhausted" | "active" | "dead" | "migrating" | "provisioning" | "info" | "success" | "error" | "debug"

const STATUS_CONFIG: Record<string, { label: string; dotClass: string; textClass: string; bgClass: string; pulse?: boolean }> = {
  // Pipeline statuses
  pending:          { label: "Pending",        dotClass: "bg-status-pending",   textClass: "text-status-pending",   bgClass: "bg-status-pending/10" },
  running:          { label: "Running",        dotClass: "bg-status-running",   textClass: "text-status-running",   bgClass: "bg-status-running/10",   pulse: true },
  completed:        { label: "Completed",      dotClass: "bg-status-completed", textClass: "text-status-completed", bgClass: "bg-status-completed/10" },
  live:             { label: "Live",           dotClass: "bg-[color:var(--success)]", textClass: "text-[color:var(--success)]", bgClass: "bg-[color:color-mix(in_oklch,var(--success)_14%,transparent)]" },
  waiting:          { label: "Waiting",        dotClass: "bg-status-waiting",   textClass: "text-status-waiting",   bgClass: "bg-status-waiting/10" },
  retryable_error:  { label: "Retrying",       dotClass: "bg-status-retryable", textClass: "text-status-retryable", bgClass: "bg-status-retryable/10" },
  terminal_error:   { label: "Failed",         dotClass: "bg-status-terminal",  textClass: "text-status-terminal",  bgClass: "bg-status-terminal/10" },
  canceled:         { label: "Canceled",       dotClass: "bg-status-canceled",  textClass: "text-status-canceled",  bgClass: "bg-status-canceled/10" },

  // Resource statuses
  healthy:          { label: "Healthy",        dotClass: "bg-[color:var(--warning)]", textClass: "text-[color:color-mix(in_oklch,var(--warning)_70%,var(--foreground))]", bgClass: "bg-[color:color-mix(in_oklch,var(--warning)_18%,transparent)]" },
  warning:          { label: "Warning",        dotClass: "bg-status-waiting",   textClass: "text-status-waiting",   bgClass: "bg-status-waiting/10" },
  exhausted:        { label: "Exhausted",      dotClass: "bg-status-terminal",  textClass: "text-status-terminal",  bgClass: "bg-status-terminal/10" },
  active:           { label: "Active",         dotClass: "bg-status-completed", textClass: "text-status-completed", bgClass: "bg-status-completed/10" },
  dead:             { label: "Dead",           dotClass: "bg-status-terminal",  textClass: "text-status-terminal",  bgClass: "bg-status-terminal/10" },
  migrating:        { label: "Migrating",      dotClass: "bg-status-running",   textClass: "text-status-running",   bgClass: "bg-status-running/10",   pulse: true },
  provisioning:     { label: "Provisioning",   dotClass: "bg-status-running",   textClass: "text-status-running",   bgClass: "bg-status-running/10",   pulse: true },

  // Log levels
  info:             { label: "Info",           dotClass: "bg-status-running",   textClass: "text-status-running",   bgClass: "bg-status-running/10" },
  success:          { label: "Success",        dotClass: "bg-status-completed", textClass: "text-status-completed", bgClass: "bg-status-completed/10" },
  error:            { label: "Error",          dotClass: "bg-status-terminal",  textClass: "text-status-terminal",  bgClass: "bg-status-terminal/10" },
  debug:            { label: "Debug",          dotClass: "bg-status-pending",   textClass: "text-status-pending",   bgClass: "bg-status-pending/10" },
}

interface StatusBadgeProps {
  status: StatusKey
  label?: string
  className?: string
  variant?: "soft" | "dot"
}

export function StatusBadge({ status, label, className, variant = "soft" }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending

  if (variant === "dot") {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-small", className)}>
        <span className="relative flex h-2 w-2">
          {config.pulse && (
            <span className={cn("absolute inline-flex h-full w-full rounded-full opacity-60 animate-status-pulse", config.dotClass)} />
          )}
          <span className={cn("relative inline-flex h-2 w-2 rounded-full", config.dotClass)} />
        </span>
        <span className={cn("text-foreground/80")}>{label ?? config.label}</span>
      </span>
    )
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-micro font-medium tabular-nums",
        config.bgClass,
        config.textClass,
        className,
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        {config.pulse && (
          <span className={cn("absolute inline-flex h-full w-full rounded-full opacity-70 animate-status-pulse", config.dotClass)} />
        )}
        <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", config.dotClass)} />
      </span>
      {label ?? config.label}
    </span>
  )
}
