/**
 * Type aliases + the canonical PIPELINE_STEPS table used across UI files.
 *
 * The seeded mock data (DOMAINS, SERVERS, CF_KEYS, LOG_EVENTS, AUDIT_ENTRIES,
 * ACTIVITY_FEED) was removed in the prod-readiness audit cleanup — those
 * fixtures pre-dated the live wiring and only existed in the bundle as
 * dead exports. The shared types and PIPELINE_STEPS stay.
 */

export type PipelineStatus =
  | "pending"
  | "running"
  | "completed"
  | "live"
  | "waiting"
  | "retryable_error"
  | "terminal_error"
  | "canceled"

export const PIPELINE_STEPS = [
  { id: 1, key: "acquire", label: "Acquire domain" },
  { id: 2, key: "cf_key", label: "Assign CF key" },
  { id: 3, key: "cf_zone", label: "Create CF zone" },
  { id: 4, key: "ns", label: "Set nameservers" },
  { id: 5, key: "droplet", label: "Provision droplet" },
  { id: 6, key: "sa_install", label: "Install ServerAvatar" },
  { id: 7, key: "ssl", label: "Issue SSL" },
  { id: 8, key: "llm_gen", label: "Generate site (LLM)" },
  { id: 9, key: "deploy", label: "Upload site" },
  { id: 10, key: "verify", label: "Verify HTTPS live" },
] as const
