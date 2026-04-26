import { NextResponse, type NextRequest } from "next/server"
import { getSession, readPasswordHash, recordLoginAttempt, verifyWerkzeugHash } from "@/lib/auth"

export const runtime = "nodejs"

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null)
  const password = (form?.get("password") as string | null) || null
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null

  if (!password) {
    return NextResponse.json({ error: "Password required" }, { status: 400 })
  }

  const stored = readPasswordHash()
  if (!stored) {
    return NextResponse.json(
      { error: "No dashboard password configured. Set one via Flask Settings page first." },
      { status: 500 },
    )
  }

  const ok = verifyWerkzeugHash(password, stored)
  recordLoginAttempt(ok, ip)
  if (!ok) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 })
  }

  const session = await getSession()
  session.authenticated = true
  session.loginAt = Date.now()
  await session.save()

  return NextResponse.json({ ok: true })
}
