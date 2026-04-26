/**
 * Node-runtime auth helpers. Re-exports edge-safe session config from
 * auth-config and adds password verify + DB-touching helpers. API
 * routes import from this file; middleware.ts imports from auth-config.
 */
import { getIronSession, type IronSession } from "iron-session"
import { cookies } from "next/headers"
import crypto from "node:crypto"
import { one, run } from "./db"
import { sessionOptions, type SsrSession } from "./auth-config"

export { sessionOptions, type SsrSession }

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
 */
export function verifyWerkzeugHash(plain: string, stored: string): boolean {
  if (!stored) return false
  if (!stored.includes(":")) return timingSafeEqString(plain, stored)
  const parts = stored.split("$")
  if (parts.length !== 3) return false
  const [meta, salt, hexHash] = parts
  const metaParts = meta.split(":")
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

export function readPasswordHash(): string | null {
  const row = one<{ value: string }>("SELECT value FROM settings WHERE key = ?", "dashboard_password_hash")
  if (row && row.value) return row.value
  const legacy = one<{ value: string }>("SELECT value FROM settings WHERE key = ?", "dashboard_password")
  return (legacy && legacy.value) || null
}

export function recordLoginAttempt(ok: boolean, ip: string | null) {
  run(
    "INSERT INTO audit_log (actor_ip, action, target, detail) VALUES (?, ?, ?, ?)",
    ip || "",
    ok ? "login_ok" : "login_fail",
    "operator",
    ok ? "Login succeeded" : "Bad password",
  )
}
