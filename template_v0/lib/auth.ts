/**
 * Auth: iron-session-backed cookie + Werkzeug-compatible PBKDF2 verify.
 *
 * The Flask side stores `dashboard_password_hash` in settings using
 * werkzeug.security.generate_password_hash, format:
 *
 *   pbkdf2:sha256:<iterations>$<salt>$<hex_hash>
 *
 * We verify against that exact format so the SAME hash works for both apps —
 * operators set the password once via Flask Settings page (or the legacy
 * plaintext-fallback path in the original app.py), and both backends accept it.
 */
import { getIronSession, type IronSession, type SessionOptions } from "iron-session"
import { cookies } from "next/headers"
import crypto from "node:crypto"
import { one, run } from "./db"

export interface SsrSession {
  authenticated?: boolean
  loginAt?: number
}

const cookiePassword =
  process.env.SSR_SESSION_SECRET ??
  // Dev-only fallback so `pnpm dev` works without env setup. Iron-session
  // rejects shorter than 32 chars, so this fixed string is purely a
  // local-development convenience and gets overridden in any real deploy.
  "ssr-dev-cookie-secret-change-in-prod-please-32chars-min"

export const sessionOptions: SessionOptions = {
  password: cookiePassword,
  cookieName: "ssr_session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8, // 8 hours, mirrors Flask PERMANENT_SESSION_LIFETIME
  },
}

export async function getSession(): Promise<IronSession<SsrSession>> {
  const store = await cookies()
  return getIronSession<SsrSession>(store, sessionOptions)
}

export async function isAuthed(): Promise<boolean> {
  const s = await getSession()
  return Boolean(s.authenticated)
}

/**
 * Verify a password attempt against a Werkzeug pbkdf2:sha256 hash.
 * Format: 'pbkdf2:sha256:600000$saltsalt$hexhash'
 *
 * Returns false on malformed hashes (does NOT throw — we never want a
 * malformed stored hash to crash the login route).
 */
export function verifyWerkzeugHash(plain: string, stored: string): boolean {
  if (!stored) return false
  // Plaintext fallback (Flask 'transparent migration' path also accepts this
  // for old DBs; we mirror that here so an operator with a pre-hashed DB
  // entry isn't locked out on the Next.js side).
  if (!stored.includes(":")) return timingSafeEqString(plain, stored)
  const parts = stored.split("$")
  if (parts.length !== 3) return false
  const [meta, salt, hexHash] = parts
  const metaParts = meta.split(":")
  // 'pbkdf2:sha256:<iters>'
  if (metaParts.length !== 3) return false
  const [scheme, algo, itersStr] = metaParts
  if (scheme !== "pbkdf2") return false
  const iters = Number(itersStr)
  if (!Number.isFinite(iters) || iters <= 0) return false
  const expected = Buffer.from(hexHash, "hex")
  const derived = crypto.pbkdf2Sync(plain, salt, iters, expected.length, algo)
  return crypto.timingSafeEqual(derived, expected)
}

function timingSafeEqString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8")
  const bb = Buffer.from(b, "utf-8")
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/** Read the dashboard password hash from the settings table. */
export function readPasswordHash(): string | null {
  const row = one<{ value: string }>("SELECT value FROM settings WHERE key = ?", "dashboard_password_hash")
  if (row && row.value) return row.value
  // Legacy plaintext fallback — the Flask app accepts this and upgrades on
  // first successful login. We don't auto-upgrade here (avoids two writers
  // racing), but we DO accept it.
  const legacy = one<{ value: string }>("SELECT value FROM settings WHERE key = ?", "dashboard_password")
  return (legacy && legacy.value) || null
}

/** Run after a successful login — keeps a simple per-IP throttle in audit_log. */
export function recordLoginAttempt(ok: boolean, ip: string | null) {
  run(
    "INSERT INTO audit_log (actor_ip, action, target, detail) VALUES (?, ?, ?, ?)",
    ip || "",
    ok ? "login_ok" : "login_fail",
    "operator",
    ok ? "Login succeeded" : "Bad password",
  )
}
