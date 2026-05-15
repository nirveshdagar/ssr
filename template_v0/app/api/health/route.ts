import { NextResponse } from "next/server"
import { existsSync } from "node:fs"
import path from "node:path"
import { one } from "@/lib/db"
import { hasAnyEncryptedRows } from "@/lib/secrets-vault"

export const runtime = "nodejs"

/**
 * GET /api/health — production-grade probe used by load balancers / k8s
 * liveness checks AND the install.sh post-systemd verification loop.
 * Returns 200 when DB is reachable AND the Fernet keyfile is in a healthy
 * state (either present, or absent-but-no-encrypted-rows-exist on a brand
 * new install). 503 + JSON detail otherwise.
 *
 * Public route — no auth gate (middleware allowlist). The body intentionally
 * contains no secrets / version info / internal paths so an unauthenticated
 * scanner learns only "healthy or not".
 */
export async function GET() {
  const checks: Record<string, "ok" | string> = {}

  // 1. SQLite is up. Cheap query — just verifies the connection cache is
  //    valid and the file is readable.
  try {
    const r = one<{ n: number }>("SELECT 1 AS n")
    checks.db = r?.n === 1 ? "ok" : "no rows"
  } catch (e) {
    checks.db = `error: ${(e as Error).message}`
  }

  // 2. Fernet key file health. Three states:
  //    a. file exists → "ok"
  //    b. file missing AND no encrypted rows → "ok (lazy)" — fresh install,
  //       key will be auto-generated on the first encrypt() call. This is
  //       the install.sh first-boot state; without this branch the script
  //       times out waiting for /api/health and prints a misleading
  //       "didn't bind :3000" error even though the dashboard is up.
  //    c. file missing AND encrypted rows present → "missing" — production
  //       data is unreadable until the key is restored. Hard 503.
  const keyPath = process.env.SSR_FERNET_KEY_PATH
    ?? path.resolve(process.env.SSR_DB_PATH ? path.dirname(process.env.SSR_DB_PATH) : path.join(process.cwd(), "..", "data"), ".ssr_secret_fernet")
  if (existsSync(keyPath)) {
    checks.fernet = "ok"
  } else {
    try {
      checks.fernet = hasAnyEncryptedRows() ? "missing" : "ok (lazy)"
    } catch {
      // hasAnyEncryptedRows shouldn't throw on a healthy DB — but if the
      // schema isn't bootstrapped yet, treat as fresh install.
      checks.fernet = "ok (lazy)"
    }
  }

  // "ok" and "ok (lazy)" both count as healthy; only specific failures count
  // as degraded. Keeps the binary loadbalancer behavior while letting
  // install.sh succeed on fresh boots.
  const allOk = Object.values(checks).every((v) => v === "ok" || v === "ok (lazy)")
  return NextResponse.json(
    { status: allOk ? "ok" : "degraded", checks },
    { status: allOk ? 200 : 503 },
  )
}
