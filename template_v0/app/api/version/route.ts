import { NextResponse } from "next/server"

export const runtime = "nodejs"

/**
 * GET /api/version — which commit is this build serving?
 *
 * NOT in middleware PUBLIC_PATHS, so it's auth-gated like everything else.
 * Deliberately separate from /api/health, which documents that it must
 * stay version-free for unauthenticated scanners. Use this (logged in) or
 * the sidebar footer to confirm prod isn't running stale code — the root
 * cause of the 2026-05-16 deploy-freeze saga.
 */
export function GET() {
  return NextResponse.json({
    sha: process.env.SSR_GIT_SHA ?? "unknown",
    builtAt: process.env.SSR_BUILD_TIME ?? null,
  })
}
