import { NextResponse, type NextRequest } from "next/server"
import { runAll } from "@/lib/preflight"

export const runtime = "nodejs"

/**
 * Environment-wide config health (Spaceship/registrant/CF/DO/SA/LLM/…).
 * `runAll()`'s checks are global — the per-domain route /api/preflight/
 * [domain] already documents this; this is the dashboard-level entry so
 * a misconfigured environment is visible at a glance instead of only
 * surfacing when a pipeline fails (the 2026-05-16 separate-DB saga).
 *
 * Auth-gated (not in middleware PUBLIC_PATHS).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const skipPurchase = new URL(req.url).searchParams.get("skip_purchase") === "on"
  const report = await runAll({ skipPurchase })
  return NextResponse.json(report)
}
