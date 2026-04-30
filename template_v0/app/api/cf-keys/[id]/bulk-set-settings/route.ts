import { NextResponse, type NextRequest } from "next/server"
import { all } from "@/lib/db"
import { enqueueJob } from "@/lib/jobs"
import { appendAudit } from "@/lib/repos/audit"
import { VALID_SSL_MODES, type SslMode } from "@/lib/cloudflare"

export const runtime = "nodejs"

const MAX_BULK = 1000

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const keyId = Number(id)
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const requested = (form?.getAll("domains") ?? []).map((v) => String(v))
  const sslRaw = ((form?.get("ssl_mode") as string | null) || "").trim().toLowerCase()
  const ahRaw = ((form?.get("always_https") as string | null) || "").trim().toLowerCase()

  if (requested.length === 0) return NextResponse.json({ error: "No domains selected" }, { status: 400 })
  if (requested.length > MAX_BULK) {
    return NextResponse.json(
      { error: `too many domains (${requested.length} > ${MAX_BULK})` },
      { status: 413 },
    )
  }

  let sslMode: SslMode | null = null
  if (sslRaw) {
    if (!VALID_SSL_MODES.includes(sslRaw as SslMode)) {
      return NextResponse.json({ error: `Invalid ssl_mode ${JSON.stringify(sslRaw)}` }, { status: 400 })
    }
    sslMode = sslRaw as SslMode
  }
  let alwaysHttps: boolean | null = null
  if (ahRaw === "on") alwaysHttps = true
  else if (ahRaw === "off") alwaysHttps = false
  else if (ahRaw && ahRaw !== "unchanged") {
    return NextResponse.json({ error: `Invalid always_https ${JSON.stringify(ahRaw)}` }, { status: 400 })
  }

  if (sslMode === null && alwaysHttps === null) {
    return NextResponse.json({ error: "Pick at least one setting" }, { status: 400 })
  }

  const placeholders = requested.map(() => "?").join(",")
  const verified = all<{ domain: string }>(
    `SELECT domain FROM domains WHERE cf_key_id = ? AND domain IN (${placeholders})`,
    keyId,
    ...requested,
  ).map((r) => r.domain)
  const verifiedSet = new Set(verified)
  const rejected = requested.filter((d) => !verifiedSet.has(d))
  if (rejected.length) {
    return NextResponse.json({ error: `${rejected.length} domains not on this key`, rejected: rejected.slice(0, 5) }, { status: 403 })
  }

  const jobId = enqueueJob("cf.bulk_set_settings", {
    key_id: keyId,
    domains: verified,
    ssl_mode: sslMode,
    always_https: alwaysHttps,
  })
  appendAudit(
    "cf_bulk_set_settings",
    `cf_key=${keyId}`,
    `ssl_mode=${sslMode} always_https=${alwaysHttps} count=${verified.length} job=${jobId}`,
    ip,
  )
  return NextResponse.json({ ok: true, job_id: jobId, count: verified.length })
}
