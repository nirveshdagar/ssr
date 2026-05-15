import { NextResponse, type NextRequest } from "next/server"
import { all } from "@/lib/db"
import { getZoneSetting } from "@/lib/cloudflare"

export const runtime = "nodejs"

interface ZoneSettingsRow {
  domain: string
  ssl_mode: string | null
  always_https: "on" | "off" | null
  error: string | null
}

/**
 * Fetch live SSL mode + Always-Use-HTTPS settings from Cloudflare for every
 * domain assigned to this CF pool key. Settings live on the CF zone, not in
 * our DB — so this is an on-demand fetch, called by the per-key "Load CF
 * settings" button. Per-domain failures don't abort the rest; each row
 * carries its own error string when the lookup throws.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const keyId = Number.parseInt(id, 10)
  if (!Number.isFinite(keyId)) {
    return NextResponse.json({ error: "invalid key id" }, { status: 400 })
  }

  const domains = all<{ domain: string }>(
    "SELECT domain FROM domains WHERE cf_key_id = ? ORDER BY domain",
    keyId,
  ).map((r) => r.domain)

  const rows: ZoneSettingsRow[] = await Promise.all(
    domains.map(async (d): Promise<ZoneSettingsRow> => {
      try {
        const [ssl, alwaysHttps] = await Promise.all([
          getZoneSetting(d, "ssl"),
          getZoneSetting(d, "always_use_https"),
        ])
        return {
          domain: d,
          ssl_mode: typeof ssl === "string" ? ssl : null,
          always_https: alwaysHttps === "on" || alwaysHttps === "off" ? alwaysHttps : null,
          error: null,
        }
      } catch (e) {
        return {
          domain: d,
          ssl_mode: null,
          always_https: null,
          error: (e as Error).message.slice(0, 200),
        }
      }
    }),
  )

  return NextResponse.json({ rows })
}
