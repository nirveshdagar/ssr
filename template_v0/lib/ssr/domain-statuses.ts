/**
 * Full list of raw domain statuses Flask exposes in its `/domains?status=…`
 * dropdown. Mirrors the Flask domains.html template exactly so operators
 * filtering for a specific pipeline state see the same options here.
 *
 * The Node side normalizes these into PipelineStatus for chip rendering,
 * but the dropdown filters against the raw value directly.
 */
export interface RawStatusOption {
  value: string
  label: string
  /** Optional grouping for visual separation in the dropdown. */
  group: "ok" | "in-flight" | "waiting" | "ready" | "error" | "other"
}

export const RAW_STATUSES: RawStatusOption[] = [
  // OK
  { value: "live",                     label: "Live",                     group: "ok" },
  { value: "hosted",                   label: "Hosted",                   group: "ok" },
  { value: "ssl_installed",            label: "SSL Installed",            group: "ok" },
  // In-flight (still moving through pipeline)
  { value: "pending",                  label: "Pending",                  group: "in-flight" },
  { value: "purchased",                label: "Purchased",                group: "in-flight" },
  { value: "owned",                    label: "Owned (BYO)",              group: "in-flight" },
  { value: "owned_external",           label: "Owned — External Registrar", group: "in-flight" },
  { value: "cf_assigned",              label: "CF Key Assigned",          group: "in-flight" },
  { value: "zone_created",             label: "CF Zone Created",          group: "in-flight" },
  { value: "ns_set",                   label: "NS Set",                   group: "in-flight" },
  { value: "zone_active",              label: "Zone Active",              group: "in-flight" },
  { value: "app_created",              label: "App Created",              group: "in-flight" },
  // Waiting on something external
  { value: "ns_pending_external",      label: "NS Pending (external)",    group: "waiting" },
  { value: "manual_action_required",   label: "Manual Action Required",   group: "waiting" },
  { value: "waiting_dns",              label: "Waiting (DNS)",            group: "waiting" },
  // Ready for next phase
  { value: "ready_for_ssl",            label: "Ready for SSL",            group: "ready" },
  { value: "ready_for_content",        label: "Ready for Content",        group: "ready" },
  // Error states
  { value: "retryable_error",          label: "Retryable Error",          group: "error" },
  { value: "terminal_error",           label: "Terminal Error",           group: "error" },
  { value: "content_blocked",          label: "Content Blocked",          group: "error" },
  { value: "cf_pool_full",             label: "CF Pool Full",             group: "error" },
  { value: "purchase_failed",          label: "Purchase Failed",          group: "error" },
  { value: "error",                    label: "Error (legacy)",           group: "error" },
  // Other
  { value: "canceled",                 label: "Canceled",                 group: "other" },
]

export const RAW_STATUS_GROUPS = {
  "ok": "Hosted / Live",
  "in-flight": "In flight",
  "waiting": "Waiting",
  "ready": "Ready",
  "error": "Errors",
  "other": "Other",
} as const
