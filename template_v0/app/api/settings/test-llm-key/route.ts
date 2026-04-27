import { NextResponse, type NextRequest } from "next/server"
import { getSetting } from "@/lib/repos/settings"

export const runtime = "nodejs"

const VALID_PROVIDERS = ["anthropic", "openai", "openrouter", "gemini"] as const

/**
 * Validate an API key for one of the supported LLM providers via a cheap
 * authenticated probe. Form may pass `provider` and `llm_api_key` to test
 * current form values; otherwise falls back to stored DB values.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const form = await req.formData().catch(() => null)
  const provider = (
    (form?.get("provider") as string | null) ||
    getSetting("llm_provider") || "anthropic"
  ).trim().toLowerCase()
  const key = ((form?.get("llm_api_key") as string | null) || "").trim() ||
              (getSetting(`llm_api_key_${provider}`) || "").trim() ||
              (getSetting("llm_api_key") || "").trim()
  if (!key) {
    return NextResponse.json({ ok: false, error: "No API key provided" }, { status: 400 })
  }

  try {
    if (provider === "anthropic") {
      const model = getSetting("llm_model") || "claude-haiku-4-5-20251001"
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model, max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: AbortSignal.timeout(20_000),
      })
      if (r.status === 200) {
        const data = (await r.json()) as { model?: string; usage?: Record<string, unknown> }
        return NextResponse.json({ ok: true, provider, model: data.model, usage: data.usage ?? {} })
      }
      return NextResponse.json({ ok: false, provider, status: r.status, error: (await r.text()).slice(0, 300) })
    }
    if (provider === "openai") {
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (r.status === 200) {
        const data = (await r.json()) as { data?: unknown[] }
        return NextResponse.json({ ok: true, provider, info: `${(data.data ?? []).length} models accessible` })
      }
      return NextResponse.json({ ok: false, provider, status: r.status, error: (await r.text()).slice(0, 300) })
    }
    if (provider === "openrouter") {
      const r = await fetch("https://openrouter.ai/api/v1/auth/key", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (r.status === 200) {
        const j = (await r.json()) as { data?: { label?: string; usage?: unknown; limit?: unknown } }
        const d = j.data ?? {}
        return NextResponse.json({
          ok: true, provider,
          label: d.label ?? "key",
          credit_used: d.usage,
          limit: d.limit,
        })
      }
      return NextResponse.json({ ok: false, provider, status: r.status, error: (await r.text()).slice(0, 300) })
    }
    if (provider === "gemini") {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
        headers: { "x-goog-api-key": key },
        signal: AbortSignal.timeout(15_000),
      })
      if (r.status === 200) {
        const data = (await r.json()) as { models?: unknown[] }
        return NextResponse.json({ ok: true, provider, info: `${(data.models ?? []).length} models accessible` })
      }
      return NextResponse.json({ ok: false, provider, status: r.status, error: (await r.text()).slice(0, 300) })
    }
    if (!(VALID_PROVIDERS as readonly string[]).includes(provider)) {
      return NextResponse.json({ ok: false, error: `unsupported provider: ${provider}` }, { status: 400 })
    }
    return NextResponse.json({ ok: false, error: `unhandled provider: ${provider}` }, { status: 500 })
  } catch (e) {
    return NextResponse.json({ ok: false, provider, error: (e as Error).message }, { status: 200 })
  }
}
