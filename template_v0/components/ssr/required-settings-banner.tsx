"use client"

import { AlertTriangle } from "lucide-react"
import { missingRequiredSettings } from "@/lib/required-settings"

/**
 * Top-of-Settings checklist of critical config that's still unset. Renders
 * nothing once everything required is filled (no clutter when configured);
 * a loud red list otherwise. This is the field-level companion to the
 * dashboard ConfigHealthBanner — it names the exact Settings field to fix.
 */
export function RequiredSettingsBanner({ values }: { values: Record<string, unknown> }) {
  const missing = missingRequiredSettings(values)
  if (missing.length === 0) return null
  return (
    <div className="mb-5 rounded-md border border-status-terminal/50 bg-status-terminal/10 px-4 py-3">
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-status-terminal">
        <AlertTriangle className="h-4 w-4" />
        {missing.length} required setting{missing.length === 1 ? "" : "s"} not configured
      </span>
      <p className="mt-1 text-micro text-muted-foreground">
        Domains can’t be bought/provisioned until these are set. This DB is
        separate from other environments — set them here too.
      </p>
      <ul className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
        {missing.map((f) => (
          <li key={f.key} className="text-small">
            <span className="text-status-terminal">•</span>{" "}
            <span className="font-medium">{f.label}</span>{" "}
            <code className="text-micro text-muted-foreground">({f.key})</code>
          </li>
        ))}
      </ul>
    </div>
  )
}
