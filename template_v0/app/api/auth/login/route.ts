import { NextResponse, type NextRequest } from "next/server"
import { getSession, readPasswordHash, recordLoginAttempt, verifyWerkzeugHash } from "@/lib/auth"
import { loginThrottleCheck, loginThrottleRecord, loginThrottleRetryAfter } from "@/lib/login-throttle"

export const runtime = "nodejs"

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null)
  const password = (form?.get("password") as string | null) || null
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null

  if (!loginThrottleCheck(ip)) {
    const retryAfter = loginThrottleRetryAfter(ip)
    return NextResponse.json(
      {
        error: "Too many failed attempts. Try again later.",
        retry_after: retryAfter,
      },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfter) },
      },
    )
  }

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
  loginThrottleRecord(ip, ok)
  if (!ok) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 })
  }

  const session = await getSession()
  session.authenticated = true
  session.loginAt = Date.now()
  await session.save()

  return NextResponse.json({ ok: true })
}
