import { listCfKeysWithPreview } from "@/lib/repos/cf-keys"

export const runtime = "nodejs"

/**
 * One-click CSV export of the entire CF key pool. Use case: backup before
 * a destructive bulk-edit at 500-key scale, or offline analysis. Full
 * api_key is NEVER included — only the masked preview (first 6 + last 3).
 */
export async function GET(): Promise<Response> {
  const rows = listCfKeysWithPreview()
  const header = [
    "id", "alias", "email", "key_preview", "cf_account_id",
    "domains_used", "max_domains", "is_active",
    "last_used_at", "last_error", "last_error_at", "created_at",
  ]
  const lines = [header.join(",")]
  for (const r of rows) {
    lines.push([
      r.id,
      csvEscape(r.alias ?? ""),
      csvEscape(r.email),
      csvEscape(r.key_preview),
      csvEscape(r.cf_account_id ?? ""),
      r.domains_used,
      r.max_domains,
      r.is_active,
      csvEscape(r.last_used_at ?? ""),
      csvEscape(r.last_error ?? ""),
      csvEscape(r.last_error_at ?? ""),
      csvEscape(r.created_at),
    ].join(","))
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
  return new Response(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="cf-keys-${stamp}.csv"`,
    },
  })
}

/** RFC-4180 quoting: wrap in quotes if it contains comma/quote/newline; double-up internal quotes. */
function csvEscape(s: string): string {
  if (s === "") return ""
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}
