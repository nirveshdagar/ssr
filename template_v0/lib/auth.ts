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
 * Verify a password attempt against a Werkzeug-format hash.
 *
 * Supports the two hash schemes Werkzeug ships:
 *   pbkdf2:sha256:<iters>$<salt>$<hex>
 *   scrypt:<N>:<r>:<p>$<salt>$<hex>      (Werkzeug default since 3.x)
 *
 * Plus the legacy plaintext fallback (no ':' separator) for transparent-
 * upgrade compatibility with old DB rows.
 */
export function verifyWerkzeugHash(plain: string, stored: string): boolean {
  if (!stored) return false
  if (!stored.includes(":")) return timingSafeEqString(plain, stored)
  const parts = stored.split("$")
  if (parts.length !== 3) return false
  const [meta, salt, hexHash] = parts
  const metaParts = meta.split(":")
  const expected = Buffer.from(hexHash, "hex")

  if (metaParts[0] === "pbkdf2" && metaParts.length === 3) {
    const algo = metaParts[1]
    const iters = Number(metaParts[2])
    if (!Number.isFinite(iters) || iters <= 0) return false
    const derived = crypto.pbkdf2Sync(plain, salt, iters, expected.length, algo)
    return crypto.timingSafeEqual(derived, expected)
  }

  if (metaParts[0] === "scrypt" && metaParts.length === 4) {
    const N = Number(metaParts[1])
    const r = Number(metaParts[2])
    const p = Number(metaParts[3])
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false
    // Werkzeug uses (N, r, p) directly; node:crypto.scryptSync needs maxmem
    // bumped to fit them. 128 * N * r * p * 2 is the formula in node docs.
    const maxmem = 128 * N * r * p * 2
    try {
      const derived = crypto.scryptSync(plain, salt, expected.length, { N, r, p, maxmem })
      return crypto.timingSafeEqual(derived, expected)
    } catch {
      return false
    }
  }

  return false
}

function timingSafeEqString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8")
  const bb = Buffer.from(b, "utf-8")
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * Build a Werkzeug-format `pbkdf2:sha256:<iters>$<salt>$<hex>` hash from a
 * plaintext password. Matches `generate_password_hash(pw, method="pbkdf2:sha256", salt_length=16)`.
 */
export function hashPasswordPbkdf2(plain: string, iters = 600_000): string {
  const salt = crypto.randomBytes(8).toString("hex") // 16 hex chars
  const derived = crypto.pbkdf2Sync(plain, salt, iters, 32, "sha256")
  return `pbkdf2:sha256:${iters}$${salt}$${derived.toString("hex")}`
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
