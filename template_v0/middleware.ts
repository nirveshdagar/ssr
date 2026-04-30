/**
 * Auth gate. Redirects unauthenticated users to /login (or 401 on /api routes).
 *
 * Note: middleware.ts runs in the Edge runtime, but `iron-session` works
 * with the Web `cookies` API which IS edge-compatible. We do NOT call
 * better-sqlite3 here (Node-only) — middleware just inspects the session
 * cookie shape and lets the route handlers do DB work in the Node runtime.
 */
import { NextResponse, type NextRequest } from "next/server"
import { getIronSession } from "iron-session"
import { sessionOptions, type SsrSession } from "./lib/auth-config"

const PUBLIC_PATHS = new Set<string>([
  "/login",
  "/api/auth/login",
  "/api/health",
  "/healthz",
  "/favicon.ico",
])

const PUBLIC_PREFIXES = ["/_next/", "/icon", "/apple-icon", "/placeholder"]

// Methods that mutate state — additionally require Origin to match Host
// (defense-in-depth on top of sameSite=strict). A misconfigured browser
// or an exploit that defeats sameSite still hits this gate.
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

function originMatchesHost(req: NextRequest): boolean {
  const origin = req.headers.get("origin")
  // Same-origin form posts and many fetches send Origin. If absent, fall
  // back to Referer — same-origin checked there. If both absent (e.g. cli
  // tools), the cookie's sameSite=strict is the primary gate; allow.
  const host = req.headers.get("host")
  if (!host) return true
  if (origin) {
    try {
      return new URL(origin).host === host
    } catch { return false }
  }
  const referer = req.headers.get("referer")
  if (referer) {
    try {
      return new URL(referer).host === host
    } catch { return false }
  }
  return true
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next()
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next()

  // CSRF gate — applies to state-changing methods on all non-public paths.
  // Runs BEFORE auth so a cross-site attacker can't even hit a 401-vs-403
  // distinguishing oracle. /api/auth/login is in PUBLIC_PATHS and bypassed
  // — the form-post from /login itself is same-origin.
  if (STATE_CHANGING_METHODS.has(req.method) && !originMatchesHost(req)) {
    return NextResponse.json({ error: "cross-site request rejected" }, { status: 403 })
  }

  const res = NextResponse.next()
  const session = await getIronSession<SsrSession>(req, res, sessionOptions)
  if (session.authenticated) return res

  // API call from a fetch — return JSON 401, not a redirect (matches Flask
  // _security_middleware behavior).
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const loginUrl = new URL("/login", req.url)
  loginUrl.searchParams.set("next", pathname)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  // Always run middleware on /api (domain names contain dots, so the bare
  // "no path with a dot" pattern accidentally lets /api/domains/x.y.com/... through),
  // and run on every other path that isn't a Next.js static asset.
  matcher: [
    "/api/:path*",
    "/((?!_next/static|_next/image|favicon\\.ico|icon|apple-icon|placeholder).*)",
  ],
}
