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

// Resolved lazily on first read so `next build`'s page-data collection
// (which imports every route module under NODE_ENV=production but doesn't
// have real prod env vars) doesn't trip the prod-only guard. The throw
// fires the moment iron-session actually reaches for `.password` at
// request time, which is when missing config genuinely matters.
//
// Accepts BOTH `SSR_SESSION_PASSWORD` (preferred — matches iron-session's
// own terminology and what DEPLOY.md / .env.example documented) and
// `SSR_SESSION_SECRET` (legacy alias retained for backwards compat). If
// both are set, _PASSWORD wins.
function resolveCookiePassword(): string {
  const envSecret =
    process.env.SSR_SESSION_PASSWORD ?? process.env.SSR_SESSION_SECRET
  if (process.env.NODE_ENV === "production" && (!envSecret || envSecret.length < 32)) {
    throw new Error(
      "SSR_SESSION_PASSWORD must be set to a 32+ char random string in production. " +
      "Generate one with `openssl rand -base64 48` and set it in your environment.",
    )
  }
  return envSecret && envSecret.length >= 32
    ? envSecret
    : "ssr-dev-cookie-secret-change-in-prod-please-32chars-min"
}

export const sessionOptions: SessionOptions = {
  get password(): string { return resolveCookiePassword() },
  cookieName: "ssr_session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    // strict (not lax): there's no SSO / external login flow, so we never
    // need cross-site navigation to carry the cookie. Strict closes the
    // CSRF surface on every state-changing route — a malicious page on
    // another origin cannot trigger an authenticated request.
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 8,
  },
}
