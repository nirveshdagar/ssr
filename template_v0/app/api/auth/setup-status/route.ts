import { NextResponse } from "next/server"
import { one } from "@/lib/db"

export const runtime = "nodejs"

/**
 * GET /api/auth/setup-status — public probe used by /login on mount to
 * decide whether to render the "Set initial password" form (fresh deploy)
 * or the normal "Sign in" form (password already configured).
 *
 * Returns nothing else — no version, no error detail. An unauthenticated
 * scanner learns only "is bootstrap done or not", which is information
 * they could trivially get by trying to log in anyway.
 */
export async function GET(): Promise<Response> {
  const row = one<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    "dashboard_password_hash",
  )
  return NextResponse.json({ needs_setup: !row?.value })
}
