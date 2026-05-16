/**
 * The minimum settings a domain CANNOT be bought/provisioned without.
 * Empty values here are the exact gap that silently broke prod for days
 * (registrant_* + Spaceship creds missing on prod's separate DB). The
 * Settings page flags these so the operator sees what's unset BEFORE a
 * pipeline 422s, not after.
 *
 * Pure + dependency-free so it's trivially unit-tested.
 */
export interface RequiredField {
  key: string
  label: string
}

export const REQUIRED_SETTINGS: RequiredField[] = [
  { key: "spaceship_api_key", label: "Spaceship API key" },
  { key: "spaceship_api_secret", label: "Spaceship API secret" },
  { key: "registrant_first_name", label: "Registrant first name" },
  { key: "registrant_last_name", label: "Registrant last name" },
  { key: "registrant_email", label: "Registrant email" },
  { key: "registrant_phone", label: "Registrant phone" },
  { key: "registrant_address", label: "Registrant address" },
  { key: "registrant_city", label: "Registrant city" },
  { key: "registrant_state", label: "Registrant state/province" },
  { key: "registrant_zip", label: "Registrant ZIP / postcode" },
  { key: "registrant_country", label: "Registrant country" },
  { key: "do_api_token", label: "DigitalOcean API token" },
]

/** Returns the required fields that are unset/blank in `values`. */
export function missingRequiredSettings(
  values: Record<string, unknown> | null | undefined,
): RequiredField[] {
  return REQUIRED_SETTINGS.filter(({ key }) => {
    const v = values?.[key]
    return v == null || (typeof v === "string" && v.trim() === "")
  })
}
