import { NextResponse, type NextRequest } from "next/server"
import { getDb } from "@/lib/db"
import { setSetting } from "@/lib/repos/settings"
import { getSession, hashPasswordPbkdf2 } from "@/lib/auth"
import { loginThrottleCheckAndReserve, loginThrottleRetryAfter } from "@/lib/login-throttle"
import { appendAudit } from "@/lib/repos/audit"
import { clientIp } from "@/lib/request-ip"

export const runtime = "nodejs"

const MIN_PASSWORD_LEN = 12

/**
 * POST /api/auth/setup — first-boot password creation.
 *
 * Public route (in middleware allowlist). Creates the operator password
 * if and only if `dashboard_password_hash` is currently empty, then logs
 * the caller in (sets the iron-session cookie). Once any password is
 * configured, this endpoint refuses with 409 — the operator must use the
 * authenticated `/settings/security` flow to rotate.
 *
 * Body: JSON `{ password: string }` — minimum 12 chars.
 *
 * The login-throttle bucket is shared with /api/auth/login so an attacker
 * can't trial-and-error this endpoint independently. Atomic check-and-set
 * inside BEGIN IMMEDIATE prevents two concurrent first-boot requests from
 * both succeeding (one wins, the other hits 409).
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = clientIp(req)
  if (!loginThrottleCheckAndReserve(ip)) {
    const retryAfter = loginThrottleRetryAfter(ip)
    return NextResponse.json(
      { error: "Too many attempts. Try again later.", retry_after: retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    )
  }

  let body: { password?: unknown }
  try {
    body = (await req.json()) as { password?: unknown }
  } catch {
    return NextResponse.json({ error: "expected JSON body" }, { status: 400 })
  }
  const password = typeof body.password === "string" ? body.password.trim() : ""
  if (!password || password.length < MIN_PASSWORD_LEN) {
    return NextResponse.json(
      { error: `password must be at least ${MIN_PASSWORD_LEN} characters` },
      { status: 400 },
    )
  }

  // Atomic: only succeeds if no password is currently set. Two concurrent
  // first-boot requests would otherwise both pass the existence check and
  // both write — last-writer-wins semantics. BEGIN IMMEDIATE serializes.
  const db = getDb()
  db.exec("BEGIN IMMEDIATE")
  try {
    const existing = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("dashboard_password_hash") as { value: string } | undefined
    if (existing?.value) {
      db.exec("ROLLBACK")
      try { appendAudit("auth_setup_rejected_already_configured", "", "", ip) } catch { /* ignore */ }
      return NextResponse.json(
        { error: "Password already configured. Use Settings → Security to rotate." },
        { status: 409 },
      )
    }
    setSetting("dashboard_password_hash", hashPasswordPbkdf2(password))
    setSetting("dashboard_password", "") // clear any legacy plaintext
    db.exec("COMMIT")
  } catch (e) {
    try { db.exec("ROLLBACK") } catch { /* ignore */ }
    throw e
  }

  // Log the operator in immediately so they don't have to bounce through
  // /login again with the password they just set.
  const session = await getSession()
  session.authenticated = true
  session.loginAt = Date.now()
  await session.save()

  try { appendAudit("auth_setup_initial", "", "initial password set", ip) } catch { /* ignore */ }
  return NextResponse.json({ ok: true })
}
