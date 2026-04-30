import { NextResponse, type NextRequest } from "next/server"
import { getSession, readPasswordHash, recordLoginAttempt, verifyWerkzeugHash } from "@/lib/auth"
import { loginThrottleCheckAndReserve, loginThrottleRecord, loginThrottleRetryAfter } from "@/lib/login-throttle"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null)
  const password = (form?.get("password") as string | null) || null
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null

  if (!loginThrottleCheckAndReserve(ip)) {
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
  // Same generic 401 whether the password row is missing or wrong — don't
  // give an unauthenticated scanner a fingerprint of "fresh deploy, race
  // the operator to set a password". Audit-log the unconfigured case so
  // an admin notices probing.
  if (!stored) {
    try {
      appendAudit("login_failure", "", "no_password_configured", ip)
    } catch { /* never block auth on audit failure */ }
    return NextResponse.json({ error: "Invalid password" }, { status: 401 })
  }

  const ok = verifyWerkzeugHash(password, stored)
  recordLoginAttempt(ok, ip)
  // The failed-attempt slot was already reserved by `checkAndReserve`
  // above, so we only need to TOUCH the bucket on success (to clear it).
  if (ok) loginThrottleRecord(ip, true)
  try {
    appendAudit(ok ? "login_success" : "login_failure", "", "", ip)
  } catch { /* never block auth on audit failure */ }
  if (!ok) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 })
  }

  const session = await getSession()
  session.authenticated = true
  session.loginAt = Date.now()
  await session.save()

  return NextResponse.json({ ok: true })
}
