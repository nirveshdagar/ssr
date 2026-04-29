import { NextResponse, type NextRequest } from "next/server"
import { getSetting } from "@/lib/repos/settings"
import { probeLlmCli, type CliProvider } from "@/lib/llm-cli"
import { countActiveAiKeys, getNextAiKey } from "@/lib/cf-ai-pool"

export const runtime = "nodejs"

const VALID_PROVIDERS = [
  "anthropic", "openai", "openrouter", "gemini",
  "moonshot", "cloudflare", "cloudflare_pool",
] as const
const CLI_CAPABLE = new Set<string>(["openai"])

/**
 * Validate an API key for one of the supported LLM providers via a cheap
 * authenticated probe. Form may pass `provider` and `llm_api_key` to test
 * current form values; otherwise falls back to stored DB values.
 *
 * When `mode=cli` is sent (gemini / openai only), skip the API-key probe
 * and shell out to the local CLI binary instead — confirms it's installed
 * and OAuth-logged-in.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const form = await req.formData().catch(() => null)
  const provider = (
    (form?.get("provider") as string | null) ||
    getSetting("llm_provider") || "anthropic"
  ).trim().toLowerCase()
  const mode = ((form?.get("mode") as string | null) || "apikey").trim().toLowerCase()

  if (mode === "cli") {
    if (!CLI_CAPABLE.has(provider)) {
      return NextResponse.json({
        ok: false, provider,
        error: `CLI auth is not supported for ${provider} — only openai (codex)`,
      }, { status: 400 })
    }
    const defaultModel = provider === "gemini" ? "gemini-2.5-flash" : "gpt-5-mini"
    const model = (getSetting("llm_model") || defaultModel).trim()
    const result = await probeLlmCli(provider as CliProvider, model)
    return NextResponse.json({ ...result, provider, mode: "cli", model })
  }

  // Cloudflare Workers AI POOL — sanity-check that at least one active row
  // exists, then verify the LRU row's token can list models on its account.
  if (provider === "cloudflare_pool") {
    const active = countActiveAiKeys()
    if (active === 0) {
      return NextResponse.json({
        ok: false, provider,
        error: "Pool is empty — add at least one (account_id, token) pair in Settings → LLM",
      }, { status: 400 })
    }
    try {
      const row = getNextAiKey()
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${row.account_id}/ai/models/search?per_page=1`,
        { headers: { Authorization: `Bearer ${row.api_token}` }, signal: AbortSignal.timeout(15_000) },
      )
      if (r.status !== 200) {
        return NextResponse.json({
          ok: false, provider,
          error: `LRU row #${row.id} (${row.alias ?? row.account_id.slice(0, 6)}) ` +
                 `failed verify: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`,
        })
      }
      return NextResponse.json({
        ok: true, provider,
        info: `${active} active pool row(s) · LRU row #${row.id} verified`,
      })
    } catch (e) {
      return NextResponse.json({ ok: false, provider, error: (e as Error).message }, { status: 200 })
    }
  }

  // Cloudflare Workers AI is special-cased — it needs an account ID alongside
  // the token. Form may pass `cloudflare_account_id` and `cloudflare_workers_ai_token`,
  // otherwise fall back to stored settings.
  if (provider === "cloudflare") {
    const accountId = ((form?.get("cloudflare_account_id") as string | null) || "").trim() ||
                      (getSetting("cloudflare_account_id") || "").trim()
    const token = ((form?.get("cloudflare_workers_ai_token") as string | null) || "").trim() ||
                  ((form?.get("llm_api_key") as string | null) || "").trim() ||
                  (getSetting("cloudflare_workers_ai_token") || "").trim()
    if (!accountId || !token) {
      return NextResponse.json({
        ok: false, provider,
        error: !accountId ? "cloudflare_account_id is empty" : "cloudflare_workers_ai_token is empty",
      }, { status: 400 })
    }
    try {
      // models/search returns the catalog filtered by the token's scope; if the
      // token can list models it can run them.
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=1`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
      )
      if (r.status === 200) {
        const data = (await r.json()) as { result?: unknown[]; result_info?: { total_count?: number } }
        const total = data.result_info?.total_count ?? (data.result ?? []).length
        return NextResponse.json({ ok: true, provider, info: `${total} workers-ai models accessible` })
      }
      return NextResponse.json({ ok: false, provider, status: r.status, error: (await r.text()).slice(0, 300) })
    } catch (e) {
      return NextResponse.json({ ok: false, provider, error: (e as Error).message }, { status: 200 })
    }
  }

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
    if (provider === "moonshot") {
      // OpenAI-compatible — listing models confirms the bearer is valid.
      const r = await fetch("https://api.moonshot.ai/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (r.status === 200) {
        const data = (await r.json()) as { data?: unknown[] }
        return NextResponse.json({ ok: true, provider, info: `${(data.data ?? []).length} kimi models accessible` })
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
