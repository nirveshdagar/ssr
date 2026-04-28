"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

/**
 * Generic operator-action dialog. Wraps Radix Dialog with a Cancel + primary
 * confirm button, busy spinner, and submit handler. Use this for any
 * "operator clicks button → fill form → submit → see result" flow that
 * deserves more affordance than `window.prompt`.
 */
export interface OperatorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: React.ReactNode
  submitLabel?: string
  submitVariant?: "default" | "destructive" | "outline"
  onSubmit: () => Promise<void> | void
  /** When non-null, render under the footer so the operator sees fail/ok before closing. */
  resultMessage?: string | null
  resultKind?: "ok" | "err" | null
}

export function OperatorDialog({
  open, onOpenChange, title, description, children,
  submitLabel = "Submit", submitVariant = "default",
  onSubmit, resultMessage, resultKind,
}: OperatorDialogProps) {
  const [busy, setBusy] = React.useState(false)
  async function handleSubmit() {
    setBusy(true)
    try { await onSubmit() } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Three-zone flex layout caps the dialog at 90vh of the viewport.
          Header + footer stay pinned; the middle children-area scrolls when
          content (e.g. a long code paste in a Textarea) exceeds the
          available space — operators always see Cancel + the primary
          submit button regardless of body height. */}
      <DialogContent className="flex max-h-[90vh] flex-col p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-2">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          <div className="flex flex-col gap-3">{children}</div>
          {resultMessage && (
            <div
              className={
                "mt-3 rounded-md border px-3 py-2 text-small " +
                (resultKind === "ok"
                  ? "border-status-completed/40 bg-status-completed/10 text-status-completed"
                  : "border-status-terminal/40 bg-status-terminal/10 text-status-terminal")
              }
            >
              {resultMessage}
            </div>
          )}
        </div>
        <DialogFooter className="shrink-0 border-t border-border bg-background/95 px-6 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={submitVariant === "destructive" ? "destructive" : submitVariant === "outline" ? "outline" : "default"}
            onClick={handleSubmit}
            disabled={busy}
            className="gap-1.5"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
