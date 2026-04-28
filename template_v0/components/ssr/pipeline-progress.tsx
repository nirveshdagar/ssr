import { Check, Loader2, CheckCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { PIPELINE_STEPS } from "@/lib/status-taxonomy"
import type { PipelineStatus } from "@/lib/ssr/mock-data"

const STEP_ENTRIES = Object.entries(PIPELINE_STEPS)
  .map(([num, label]) => ({ id: Number(num), label }))
  .sort((a, b) => a.id - b.id)

interface PipelineProgressProps {
  currentStep: number
  status: PipelineStatus
  className?: string
  compact?: boolean
  /** Optional ISO/SQL timestamp of when the run completed — used to render
   *  "complete · X ago" when status is a success state. If omitted on
   *  success, just shows "Pipeline complete". */
  completedAt?: string | null
}

function formatRelative(iso: string | null | undefined): string | null {
  if (!iso) return null
  // Accept SQLite "YYYY-MM-DD HH:MM:SS" (no Z) and ISO formats.
  const normalized = /\d{4}-\d{2}-\d{2}T/.test(iso) ? iso : iso.replace(" ", "T") + "Z"
  const t = Date.parse(normalized)
  if (!Number.isFinite(t)) return null
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  return `${day}d ago`
}

export function PipelineProgress({
  currentStep, status, className, compact = false, completedAt,
}: PipelineProgressProps) {
  const failed = status === "terminal_error" || status === "retryable_error"
  const canceled = status === "canceled"
  // Pipeline success — `live` (visiting URL works) and `completed` both
  // mean every step is done; render a single quiet "complete" banner
  // instead of a 10-step strip with no signal.
  const isSuccess = status === "live" || status === "completed"

  if (isSuccess) {
    const rel = formatRelative(completedAt)
    return (
      <div className={cn("w-full", className)}>
        <div
          className={cn(
            "flex items-center gap-2 rounded-md border border-status-completed/30",
            "bg-status-completed/8 px-3 py-2 text-status-completed",
            compact && "py-1.5",
          )}
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
          <span className="text-small font-medium">Pipeline complete</span>
          {rel && (
            // suppressHydrationWarning because `rel` derives from Date.now()
            // and ticks once per second; the server-rendered value is
            // ~1s older than the client-rendered one. The 1s mismatch is
            // intentional and corrects itself on the first SWR poll. This
            // is exactly the case React's docs recommend the flag for.
            <span
              className="ml-auto font-mono text-micro text-status-completed/70"
              suppressHydrationWarning
            >
              {rel}
            </span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={cn("w-full", className)}>
      <ol className="flex items-stretch gap-1.5 overflow-x-auto" role="list">
        {STEP_ENTRIES.map((step) => {
          // Note: success states ("live"/"completed") are handled by the
          // banner above and never reach this loop.
          const isCompleted = step.id < currentStep
          const isCurrent = step.id === currentStep && !canceled
          const isPending = step.id > currentStep
          const isFailed = isCurrent && failed

          return (
            <li
              key={step.id}
              className={cn(
                "group flex min-w-0 flex-1 flex-col gap-1.5",
                compact && "gap-1",
              )}
            >
              <div className="flex items-center gap-1.5">
                <div
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-micro font-semibold tabular-nums transition-colors",
                    isCompleted && "border-status-completed bg-status-completed text-primary-foreground",
                    isCurrent && !isFailed && "border-status-running bg-status-running/15 text-status-running",
                    isFailed && "border-status-terminal bg-status-terminal/15 text-status-terminal",
                    isPending && "border-border bg-card text-muted-foreground",
                    canceled && step.id > currentStep && "border-border bg-card text-muted-foreground",
                  )}
                  aria-hidden
                >
                  {isCompleted ? (
                    <Check className="h-3 w-3" strokeWidth={3} />
                  ) : isCurrent && !isFailed ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    step.id
                  )}
                </div>
                <div
                  className={cn(
                    "h-px flex-1 rounded-full transition-colors",
                    isCompleted ? "bg-status-completed" : "bg-border",
                  )}
                  aria-hidden
                />
              </div>
              {!compact && (
                <div
                  className={cn(
                    "min-w-0 flex flex-col leading-tight",
                    isCurrent && "text-foreground",
                  )}
                >
                  <span className="text-micro font-mono uppercase tracking-wider text-muted-foreground/70">
                    Step {step.id}
                  </span>
                  <span
                    className={cn(
                      "truncate text-small font-medium",
                      isCompleted && "text-foreground",
                      isCurrent && !isFailed && "text-status-running",
                      isFailed && "text-status-terminal",
                      isPending && "text-muted-foreground",
                    )}
                    title={step.label}
                  >
                    {step.label}
                  </span>
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
