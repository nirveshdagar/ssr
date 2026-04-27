import { Check, Loader2 } from "lucide-react"
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
}

export function PipelineProgress({ currentStep, status, className, compact = false }: PipelineProgressProps) {
  const failed = status === "terminal_error" || status === "retryable_error"
  const canceled = status === "canceled"

  return (
    <div className={cn("w-full", className)}>
      <ol className="flex items-stretch gap-1.5 overflow-x-auto" role="list">
        {STEP_ENTRIES.map((step) => {
          const isCompleted = step.id < currentStep || status === "live"
          const isCurrent = step.id === currentStep && !canceled && status !== "live"
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
