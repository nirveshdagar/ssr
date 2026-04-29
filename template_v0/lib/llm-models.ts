/**
 * Known LLM models per provider, used to populate the Model dropdown in
 * /settings and every Run/Regenerate dialog.
 *
 * Static list — not fetched dynamically because:
 *   - Most providers don't have an "auth-free" /models listing endpoint
 *   - Calling each provider's API on every settings page open would burn
 *     the operator's API quota
 *   - Models change rarely enough that bumping this list is fine
 *
 * The list is curated, not exhaustive — the most common / recommended
 * models for landing-page generation. Operators who want something not
 * listed can pick "(custom — type your own)" and free-type.
 *
 * Mark exactly ONE model per provider as `default: true` so the dashboard
 * can render it as the default selection when no `llm_model` setting is
 * present.
 */
export interface ModelOption {
  id: string
  /** Optional short label shown next to the model id. Empty = id only. */
  label?: string
  /** Marks the curated default for this provider. */
  default?: boolean
  /** Optional one-liner shown in the dropdown for tradeoffs (cost, latency, capability). */
  notes?: string
}

// Cloudflare Workers AI's chat-completion catalog (curated subset). All of
// these are billable via the same neuron quota, so the free 10k/day tier
// covers any of them. Listed roughly best-to-fast for landing-page generation.
const CF_WORKERS_AI_MODELS: ModelOption[] = [
  { id: "@cf/moonshotai/kimi-k2.6", label: "Kimi K2.6", default: true, notes: "reasoning — needs 16k+ output tokens" },
  { id: "@cf/google/gemma-4-31b-it", label: "Gemma 4 31B", notes: "non-reasoning, very capable, ~30B class" },
  { id: "@cf/google/gemma-3-27b-it", label: "Gemma 3 27B", notes: "non-reasoning, balanced" },
  { id: "@cf/google/gemma-2-9b-it", label: "Gemma 2 9B", notes: "non-reasoning, fast + cheap" },
  { id: "@cf/meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B", notes: "non-reasoning, capable" },
  { id: "@cf/meta/llama-3.2-90b-vision-instruct", label: "Llama 3.2 90B Vision", notes: "non-reasoning, multimodal" },
  { id: "@cf/meta/llama-3.1-70b-instruct", label: "Llama 3.1 70B", notes: "non-reasoning, legacy capable" },
  { id: "@cf/meta/llama-3.1-8b-instruct", label: "Llama 3.1 8B", notes: "non-reasoning, fastest" },
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct", label: "Qwen2.5 Coder 32B", notes: "non-reasoning, code/HTML focused" },
  { id: "@cf/qwen/qwen2.5-72b-instruct", label: "Qwen2.5 72B", notes: "non-reasoning, capable" },
  { id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", label: "DeepSeek R1 distill 32B", notes: "reasoning, distilled" },
  { id: "@cf/mistral/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B", notes: "non-reasoning, balanced" },
  { id: "@cf/mistral/mistral-7b-instruct-v0.3", label: "Mistral 7B v0.3", notes: "non-reasoning, fast" },
  { id: "@cf/microsoft/phi-3.5-mini-instruct", label: "Phi-3.5 mini", notes: "non-reasoning, very fast" },
  { id: "@cf/anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5 (CF)", notes: "if your account has access" },
]

export const KNOWN_MODELS_BY_PROVIDER: Record<string, ModelOption[]> = {
  anthropic: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", default: true, notes: "fast + cheap, default for landing pages" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (alias)", notes: "rolling alias, no version pin" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", notes: "balanced" },
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", notes: "balanced, prior" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", notes: "highest quality, slow + expensive" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6", notes: "prior flagship" },
    { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku (legacy)", notes: "older but cheap" },
    { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet (legacy)", notes: "older balanced" },
  ],
  openai: [
    { id: "gpt-5.5", label: "GPT-5.5", default: true, notes: "codex CLI default" },
    { id: "gpt-5", label: "GPT-5", notes: "flagship" },
    { id: "gpt-5-mini", label: "GPT-5 mini", notes: "fast + cheap" },
    { id: "gpt-5-nano", label: "GPT-5 nano", notes: "smallest, very fast" },
    { id: "gpt-4.1", label: "GPT-4.1", notes: "prior generation" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 mini", notes: "prior fast tier" },
    { id: "gpt-4o", label: "GPT-4o", notes: "legacy capable tier" },
    { id: "gpt-4o-mini", label: "GPT-4o mini", notes: "legacy fast tier" },
    { id: "o3", label: "o3", notes: "reasoning, expensive" },
    { id: "o3-mini", label: "o3-mini", notes: "reasoning, slower" },
    { id: "o1", label: "o1", notes: "reasoning, legacy" },
    { id: "o1-mini", label: "o1-mini", notes: "reasoning, legacy fast" },
  ],
  gemini: [
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", default: true, notes: "fast + free tier friendly" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", notes: "even faster, cheaper" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", notes: "highest quality" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", notes: "legacy fast" },
    { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite", notes: "legacy fast cheap" },
    { id: "gemini-2.0-pro", label: "Gemini 2.0 Pro", notes: "legacy capable" },
    { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash (legacy)" },
    { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro (legacy)" },
    // Gemma — Google's open-weights family, served through the same AI
    // Studio / Gemini API endpoint with the same `x-goog-api-key` auth.
    // Free-tier quota is separate from the gemini-* models, so listing
    // Gemma here gives the operator a fallback when the gemini-* daily
    // quota is exhausted.
    { id: "gemma-4-31b-it", label: "Gemma 4 31B IT", notes: "open-weights, capable, ~30B class" },
    { id: "gemma-4-9b-it", label: "Gemma 4 9B IT", notes: "open-weights, fast" },
    { id: "gemma-3-27b-it", label: "Gemma 3 27B IT", notes: "open-weights, balanced" },
    { id: "gemma-3-12b-it", label: "Gemma 3 12B IT", notes: "open-weights, mid-tier" },
    { id: "gemma-3-4b-it", label: "Gemma 3 4B IT", notes: "open-weights, very fast" },
    { id: "gemma-3-1b-it", label: "Gemma 3 1B IT", notes: "open-weights, tiny" },
    { id: "gemma-2-27b-it", label: "Gemma 2 27B IT", notes: "open-weights, legacy capable" },
    { id: "gemma-2-9b-it", label: "Gemma 2 9B IT", notes: "open-weights, legacy fast" },
  ],
  openrouter: [
    // OpenRouter uses {vendor}/{model} ids — this is a curated cross-section.
    // The router supports hundreds; "(custom)" + the operator pasting any
    // valid OR id is the right escape hatch for the long tail.
    { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash via OR", default: true },
    { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro via OR" },
    { id: "google/gemma-4-31b-it", label: "Gemma 4 31B via OR" },
    { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5 via OR" },
    { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6 via OR" },
    { id: "openai/gpt-5", label: "GPT-5 via OR" },
    { id: "openai/gpt-5-mini", label: "GPT-5 mini via OR" },
    { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6 via OR", notes: "reasoning model" },
    { id: "deepseek/deepseek-r1", label: "DeepSeek R1 via OR", notes: "reasoning model" },
    { id: "deepseek/deepseek-v3", label: "DeepSeek V3 via OR", notes: "non-reasoning" },
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B via OR" },
    { id: "qwen/qwen2.5-coder-32b-instruct", label: "Qwen2.5 Coder 32B via OR" },
    { id: "mistralai/mistral-large", label: "Mistral Large via OR" },
  ],
  moonshot: [
    { id: "kimi-k2.6", label: "Kimi K2.6", default: true, notes: "reasoning model — needs llm_max_output_tokens >=16k" },
    { id: "kimi-k2.5", label: "Kimi K2.5", notes: "non-reasoning, simpler" },
    { id: "kimi-k2", label: "Kimi K2", notes: "legacy" },
    { id: "kimi-k1.5", label: "Kimi K1.5", notes: "older legacy" },
    { id: "moonshot-v1-8k", label: "Moonshot v1 8K", notes: "older 8K context" },
    { id: "moonshot-v1-32k", label: "Moonshot v1 32K", notes: "older 32K context" },
    { id: "moonshot-v1-128k", label: "Moonshot v1 128K", notes: "older 128K context" },
  ],
  // Cloudflare Workers AI — single account and pooled use the same model
  // catalog (the pool just round-robins requests across CF accounts, model
  // id is identical). Reuse one constant so adding/removing a model touches
  // both rows in lockstep.
  cloudflare: CF_WORKERS_AI_MODELS,
  cloudflare_pool: CF_WORKERS_AI_MODELS,
}

export function getDefaultModelFor(provider: string): string {
  const list = KNOWN_MODELS_BY_PROVIDER[provider] ?? []
  return list.find((m) => m.default)?.id ?? list[0]?.id ?? ""
}
