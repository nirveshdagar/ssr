import { NextResponse } from "next/server"
import { listCfAiKeysWithPreview } from "@/lib/repos/cf-ai-keys"
import { countActiveAiKeys } from "@/lib/cf-ai-pool"

export const runtime = "nodejs"

/**
 * GET /api/cf-ai-keys — list pool rows with masked previews + summary stats
 * the dashboard renders as the "free budget" line under the pool table.
 */
export async function GET() {
  const keys = listCfAiKeysWithPreview()
  const active = countActiveAiKeys()
  return NextResponse.json({
    cf_ai_keys: keys,
    summary: {
      active,
      // Cloudflare Workers AI free tier: 10 000 neurons/day per account.
      // K2.6 inference is ~200-500 neurons per call depending on output length,
      // so the practical-call estimate is ~20-50 calls/day per row.
      daily_neuron_budget: active * 10_000,
    },
  })
}
