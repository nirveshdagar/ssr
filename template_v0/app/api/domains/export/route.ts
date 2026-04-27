import { type NextRequest } from "next/server"
import { listDomains } from "@/lib/repos/domains"

export const runtime = "nodejs"

function csvEscape(v: unknown): string {
  if (v == null) return ""
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

const COLUMNS = [
  "domain", "status", "cf_email", "cf_zone_id", "cf_nameservers",
  "current_proxy_ip", "server_id", "created_at",
] as const

export async function GET(_req: NextRequest): Promise<Response> {
  const rows = listDomains()
  const lines: string[] = [COLUMNS.join(",")]
  for (const d of rows) {
    lines.push(COLUMNS.map((c) => csvEscape((d as unknown as Record<string, unknown>)[c])).join(","))
  }
  // Add CRLF separator + UTF-8 BOM so Excel opens it cleanly
  const body = "﻿" + lines.join("\r\n") + "\r\n"
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ssr_domains.csv"',
    },
  })
}
