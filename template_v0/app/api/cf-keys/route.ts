import { NextResponse } from "next/server"
import { listCfKeysWithPreview, listDomainsForKey } from "@/lib/repos/cf-keys"

export const runtime = "nodejs"

/**
 * Returns CF keys with masked previews + the list of domains assigned
 * to each. Full api_key never leaves the DB (preview is computed in
 * SQL via substr). Mirrors Flask cloudflare_page route.
 */
export async function GET() {
  const keys = listCfKeysWithPreview()
  const domains_by_key: Record<number, ReturnType<typeof listDomainsForKey>> = {}
  for (const k of keys) {
    domains_by_key[k.id] = listDomainsForKey(k.id)
  }
  return NextResponse.json({ cf_keys: keys, domains_by_key })
}
