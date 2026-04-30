import { NextResponse, type NextRequest } from "next/server"
import { getSession } from "@/lib/auth"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const session = await getSession()
  session.destroy()
  try { appendAudit("logout", "", "", ip) } catch { /* ignore */ }
  return NextResponse.json({ ok: true })
}
