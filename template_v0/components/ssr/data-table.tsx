import * as React from "react"
import { cn } from "@/lib/utils"

export function DataTableShell({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
        className,
      )}
    >
      {children}
    </div>
  )
}

export function DataTableToolbar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2.5",
        className,
      )}
    >
      {children}
    </div>
  )
}

export function DataTable({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="relative overflow-x-auto">
      <table className={cn("w-full border-collapse text-small", className)}>{children}</table>
    </div>
  )
}

export function DataTableHead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur">
      {children}
    </thead>
  )
}

export function DataTableHeaderCell({
  children,
  className,
  align = "left",
}: {
  children?: React.ReactNode
  className?: string
  align?: "left" | "right" | "center"
}) {
  return (
    <th
      scope="col"
      className={cn(
        "h-8 px-3 text-micro font-medium uppercase tracking-wider text-muted-foreground border-b border-border",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
    >
      {children}
    </th>
  )
}

export function DataTableRow({
  children,
  className,
  selected,
}: {
  children: React.ReactNode
  className?: string
  selected?: boolean
}) {
  return (
    <tr
      className={cn(
        "border-b border-border/70 last:border-b-0 transition-colors hover:bg-muted/40",
        selected && "bg-primary/5",
        className,
      )}
    >
      {children}
    </tr>
  )
}

export function DataTableCell({
  children,
  className,
  align = "left",
}: {
  children?: React.ReactNode
  className?: string
  align?: "left" | "right" | "center"
}) {
  return (
    <td
      className={cn(
        "h-10 px-3 text-[13px] text-foreground/90 align-middle",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </td>
  )
}

export function MonoCode({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        "inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-mono text-micro text-foreground/80",
        className,
      )}
    >
      {children}
    </code>
  )
}
