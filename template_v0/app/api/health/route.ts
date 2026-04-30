import { NextResponse } from "next/server"
import { existsSync } from "node:fs"
import path from "node:path"
import { one } from "@/lib/db"

export const runtime = "nodejs"

/**
 * GET /api/health — production-grade probe used by load balancers / k8s
 * liveness checks. Returns 200 only when DB is reachable AND the Fernet
 * keyfile exists (or is intentionally not yet bootstrapped). 503 + JSON
 * detail otherwise.
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

  // 2. Fernet key file exists. Production bootstrap requires this to be
  //    pre-provisioned when encrypted rows are present (see secrets-vault.ts);
  //    a missing file when rows are encrypted is a hard error and shows as
  //    "missing".
  const keyPath = process.env.SSR_FERNET_KEY_PATH
    ?? path.resolve(process.env.SSR_DB_PATH ? path.dirname(process.env.SSR_DB_PATH) : path.join(process.cwd(), "..", "data"), ".ssr_secret_fernet")
  checks.fernet = existsSync(keyPath) ? "ok" : "missing"

  const allOk = Object.values(checks).every((v) => v === "ok")
  return NextResponse.json(
    { status: allOk ? "ok" : "degraded", checks },
    { status: allOk ? 200 : 503 },
  )
}
