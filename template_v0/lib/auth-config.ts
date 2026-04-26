/**
 * Edge-safe auth config — JUST the session shape + iron-session options.
 * NO Node-only imports (no node:crypto, no node:sqlite). Used by
 * middleware.ts (Edge Runtime).
 *
 * The full auth helpers (password verify, DB writes, session save)
 * live in lib/auth-server.ts and are Node-only.
 */
import type { SessionOptions } from "iron-session"

export interface SsrSession {
  authenticated?: boolean
  loginAt?: number
}

const cookiePassword =
  process.env.SSR_SESSION_SECRET ??
  "ssr-dev-cookie-secret-change-in-prod-please-32chars-min"

export const sessionOptions: SessionOptions = {
  password: cookiePassword,
  cookieName: "ssr_session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8,
  },
}
