"use client"

import * as React from "react"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { KNOWN_MODELS_BY_PROVIDER, type ModelOption } from "@/lib/llm-models"

const CUSTOM_SENTINEL = "__custom__"
const DEFAULT_SENTINEL = "__default__"

/**
 * Dropdown of known LLM models for the given provider, with a "(custom)"
 * escape hatch that reveals a free-text input for ids not in the curated
 * list (new models, fine-tuned variants, etc.) and a "(provider default)"
 * option that clears the model setting so the per-provider default kicks
 * in.
 *
 * Stateless: the parent owns the `value` (the model id, or "" for default)
 * and `onChange` is called with the new id. The component itself only
 * tracks the local "is custom mode active" UI state.
 */
export interface ModelPickerProps {
  /** Active provider — drives which models the dropdown lists. */
  provider: string
  /** Current model id. Empty string = "use provider default". */
  value: string
  onChange: (next: string) => void
  /** Override the placeholder for the custom-model text input. */
  placeholder?: string
  /** When true, omit the "(provider default)" option — use this on the
   *  /settings → LLM Default Model where there must be exactly one selection. */
  hideDefaultOption?: boolean
  /** Show a smaller variant — used inside dialogs / bulk-action bars. */
  size?: "default" | "sm"
  className?: string
}

export function ModelPicker({
  provider, value, onChange, placeholder, hideDefaultOption, size = "default", className,
}: ModelPickerProps) {
  const known = KNOWN_MODELS_BY_PROVIDER[provider] ?? []
  const isKnown = known.some((m) => m.id === value)
  const isEmpty = !value

  // "Custom" mode is sticky — once the user chooses (custom), we stay in
  // text-input mode even as they type partial values. Otherwise typing one
  // character would resolve to "no match" and snap the Select back to
  // default. Reset to dropdown if provider changes (different model list).
  const [customMode, setCustomMode] = React.useState(() => Boolean(value) && !isKnown)
  const lastProvider = React.useRef(provider)
  React.useEffect(() => {
    if (lastProvider.current !== provider) {
      lastProvider.current = provider
      setCustomMode(false)
    }
  }, [provider])

  // The `select` value: provider-id when known, sentinels for empty / custom.
  const selectValue = customMode
    ? CUSTOM_SENTINEL
    : isEmpty
      ? DEFAULT_SENTINEL
      : isKnown
        ? value
        : CUSTOM_SENTINEL // unknown but typed = custom

  function handleSelect(v: string) {
    if (v === DEFAULT_SENTINEL) {
      setCustomMode(false)
      onChange("")
    } else if (v === CUSTOM_SENTINEL) {
      setCustomMode(true)
      // don't reset value — let the operator edit whatever was there
    } else {
      setCustomMode(false)
      onChange(v)
    }
  }

  const triggerCls = size === "sm" ? "h-8 text-small" : "h-9 text-small"
  const inputCls = size === "sm" ? "h-8 text-small font-mono" : "h-9 text-small font-mono"

  return (
    <div className={className}>
      <Select value={selectValue} onValueChange={handleSelect}>
        <SelectTrigger className={triggerCls}><SelectValue /></SelectTrigger>
        <SelectContent>
          {!hideDefaultOption && (
            <SelectItem value={DEFAULT_SENTINEL}>(use provider default)</SelectItem>
          )}
          {known.map((m: ModelOption) => (
            <SelectItem key={m.id} value={m.id}>
              <span className="font-mono">{m.id}</span>
              {m.label && <span className="text-muted-foreground"> · {m.label}</span>}
              {m.notes && <span className="text-muted-foreground"> — {m.notes}</span>}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_SENTINEL}>
            (custom — type your own)
          </SelectItem>
        </SelectContent>
      </Select>
      {customMode && (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "model id (e.g. @cf/some/new-model)"}
          className={`${inputCls} mt-1.5`}
          autoFocus
        />
      )}
    </div>
  )
}
