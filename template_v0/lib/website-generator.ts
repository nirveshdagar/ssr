/**
 * LLM website generator — Node port of modules/website_generator.py.
 *
 * Two surfaces:
 *   - generateWebsite(domain, niche?, style?)   — legacy free-form HTML gen
 *   - generateSinglePage(domain)                — v2: niche inference + content
 *                                                  blocklist + JSON envelope
 *
 * Provider routing follows the `llm_provider` setting:
 *   anthropic (default) | openai | openrouter | gemini
 *
 * No vendor SDK — all calls are direct HTTP `fetch` so the byte-for-byte
 * payloads match what Flask sends (parallel-Flask parity).
 */

import { getSetting } from "./repos/settings"
import { getMasterPrompt } from "./master-prompt"
import { logPipeline } from "./repos/logs"
import { withSemaphore, getSemaphore } from "./concurrency"
import { runLlmCli, type CliProvider } from "./llm-cli"
import {
  AiPoolExhausted,
  getNextAiKey,
  recordAiKeyCall,
  recordAiKeyError,
} from "./cf-ai-pool"

// Cap concurrent LLM calls so a 50-fan-out doesn't blow per-account RPM/TPM
// quotas. Override with SSR_LLM_CONCURRENCY (min 1).
const LLM_CAP = Math.max(
  1,
  Number.parseInt(process.env.SSR_LLM_CONCURRENCY ?? "", 10) || 8,
)

/**
 * Per-call HTTP timeout for LLM API calls. Default 5 min — reasoning models
 * (K2.6, deepseek-r1) routinely spend 60-120s on chain-of-thought BEFORE
 * emitting the first answer token, so the previous 120s ceiling was tripping
 * legitimate slow generations. Override via SSR_LLM_TIMEOUT_MS or the
 * `llm_timeout_ms` setting (setting wins). Min 30s, max 15 min.
 */
function getLlmTimeoutMs(): number {
  const fromSetting = parseInt(getSetting("llm_timeout_ms") || "", 10)
  const fromEnv = parseInt(process.env.SSR_LLM_TIMEOUT_MS ?? "", 10)
  const raw = Number.isFinite(fromSetting) && fromSetting > 0
    ? fromSetting
    : Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 300_000
  return Math.min(Math.max(raw, 30_000), 15 * 60_000)
}

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

interface LlmConfig {
  provider: string
  apiKey: string
  /** When true, ignore apiKey and shell out to the provider's local CLI
   *  (gemini / codex). Only valid for providers in CLI_CAPABLE_PROVIDERS. */
  cliMode: boolean
}

// Only OpenAI's codex CLI gets the spawn-based login flow now. Gemini was
// removed because gemini-cli ≥ 0.38 hard-rejects non-interactive OAuth and
// the dashboard-handled OAuth fallback was fragile across version bumps.
// Gemini still works via API-key path (settings → llm_api_key_gemini).
const CLI_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set(["openai"])

function isCliEnabled(provider: string): boolean {
  if (!CLI_CAPABLE_PROVIDERS.has(provider)) return false
  return (getSetting(`llm_cli_enabled_${provider}`) || "0") === "1"
}

function getLlmConfig(providerOverride?: string | null): LlmConfig {
  // Per-call override (e.g. the Regenerate dialog picked a specific provider
  // for this run only) wins over the global setting. Empty / null falls back
  // to the configured default.
  const override = (providerOverride ?? "").trim().toLowerCase()
  const provider = override || (getSetting("llm_provider") || "anthropic").trim().toLowerCase()
  const cliMode = isCliEnabled(provider)
  if (cliMode) {
    return { provider, apiKey: "", cliMode: true }
  }
  // Cloudflare Workers AI uses its own settings keys (cloudflare_account_id +
  // cloudflare_workers_ai_token) — surface the token through the same apiKey
  // field so the downstream branch doesn't need a second config call.
  if (provider === "cloudflare") {
    const apiKey = (getSetting("cloudflare_workers_ai_token") || "").trim()
    if (!apiKey) {
      throw new Error(
        "cloudflare_workers_ai_token is empty — set it in Settings → LLM " +
        "(create a Workers AI token at dash.cloudflare.com → My Profile → API Tokens)",
      )
    }
    return { provider, apiKey, cliMode: false }
  }
  // cloudflare_pool: per-call credentials come from cf-ai-pool.getNextAiKey().
  // No apiKey at config time; the generation branch picks one per attempt and
  // retries against the next row on 429/quota errors.
  if (provider === "cloudflare_pool") {
    return { provider, apiKey: "", cliMode: false }
  }
  const perProvider = getSetting(`llm_api_key_${provider}`) || ""
  const apiKey = perProvider || getSetting("llm_api_key") || ""
  if (!apiKey) {
    throw new Error(
      `No API key set for provider '${provider}'. ` +
      `Paste one into Settings → llm_api_key_${provider} (or the generic llm_api_key), ` +
      `or enable Use-local-CLI-auth for gemini/openai.`,
    )
  }
  return { provider, apiKey, cliMode: false }
}

// ---------------------------------------------------------------------------
// Cloudflare Workers AI helper — shared between the single-account
// `cloudflare` branch and the round-robin `cloudflare_pool` branch.
// ---------------------------------------------------------------------------

interface CloudflareCallArgs {
  accountId: string
  token: string
  model: string
  systemMsg: string
  userMsg: string
  maxTokens: number
}

async function callCloudflareWorkersAi(args: CloudflareCallArgs): Promise<{
  text: string
  usage: UsageInfo
}> {
  const { accountId, token, model, systemMsg, userMsg, maxTokens } = args
  // K2.6 (and other reasoning models on CF Workers AI) split their output
  // budget between `reasoning_content` (chain-of-thought) and `content`
  // (the actual answer). With max_completion_tokens=3500 and a long brief,
  // the reasoning eats the whole budget — content stays null and the call
  // returns finish_reason="length" with nothing usable.
  // Bump the cap for reasoning models so reasoning + answer both fit.
  const isReasoningModel = /kimi-k2|deepseek-r1|qwq|reasoning/i.test(model)
  const effectiveMaxTokens = isReasoningModel ? Math.max(maxTokens, 16_000) : maxTokens
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: userMsg },
        ],
        max_completion_tokens: effectiveMaxTokens,
      }),
      signal: AbortSignal.timeout(getLlmTimeoutMs()),
    },
  )
  if (!res.ok) {
    throw new Error(`cloudflare HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  // CF Workers AI returns TWO different shapes depending on the model:
  //   - Older / "function" models: { result: { response: "..." | choices: [...] }, success, errors }
  //   - Newer chat-completion models (K2.6, llama-3.1-instruct, etc): top-level
  //     OpenAI shape — { id, model, choices: [{ message: { content } }], usage }
  //     with NO result envelope and NO success flag.
  // We try both. If neither yields text, log the raw body so the next pass
  // shows us what shape we got.
  type Choice = {
    message?: { content?: string | null; reasoning_content?: string | null }
    finish_reason?: string
  }
  type Usage = { prompt_tokens?: number; completion_tokens?: number }
  const apiBody = (await res.json()) as {
    success?: boolean
    errors?: { message?: string }[]
    result?: { response?: string; choices?: Choice[]; usage?: Usage }
    // Top-level OpenAI shape:
    choices?: Choice[]
    usage?: Usage
    response?: string
  }
  if (apiBody.success === false) {
    const msg = (apiBody.errors ?? []).map((e) => e.message).filter(Boolean).join("; ") || "unknown"
    throw new Error(`cloudflare workers-ai error: ${msg}`)
  }
  const r = apiBody.result ?? {}
  const choice = r.choices?.[0] ?? apiBody.choices?.[0]
  const text = (choice?.message?.content ?? r.response ?? apiBody.response ?? "") || ""
  const u: Usage = (r.usage ?? apiBody.usage ?? {}) as Usage
  if (!text) {
    // Reasoning model overflow detection — the model spent all its tokens
    // on `reasoning_content` and never wrote the actual answer. Specific
    // error so the operator (or future me) doesn't have to dig the JSON.
    const reasoning = choice?.message?.reasoning_content
    const finish = choice?.finish_reason
    if (finish === "length" && reasoning) {
      throw new Error(
        `cloudflare workers-ai: ${model} ran out of tokens during reasoning ` +
        `(finish_reason=length, reasoning_content=${reasoning.length} chars, content=null). ` +
        `Bump llm_max_output_tokens in /settings to 16000+, OR switch to a non-reasoning model ` +
        `(@cf/meta/llama-3.3-70b-instruct, @cf/google/gemma-3-27b-it).`,
      )
    }
    const sample = JSON.stringify(apiBody).slice(0, 600)
    throw new Error(`cloudflare workers-ai returned empty content. Body: ${sample}`)
  }
  return {
    text,
    usage: {
      input_tokens: u.prompt_tokens ?? null,
      output_tokens: u.completion_tokens ?? null,
    },
  }
}

/**
 * Detect failures that mean "this row is rate-limited or out of free-tier
 * neurons" — the only class we want the pool to retry with a different row.
 * Surface message can be the HTTP status string or CF's success=false body.
 */
function isCloudflareQuotaError(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes("http 429") ||
    m.includes("rate limit") ||
    m.includes("rate-limit") ||
    m.includes("quota") ||
    m.includes("neuron") ||
    m.includes("daily limit") ||
    m.includes("usage limit")
  )
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ContentBlockedError extends Error {
  reason: string
  inferredNiche: string
  constructor(reason: string, inferredNiche = "") {
    super(reason)
    this.name = "ContentBlockedError"
    this.reason = reason
    this.inferredNiche = inferredNiche
  }
}

// ---------------------------------------------------------------------------
// V1 — legacy single-call HTML gen (still used by older flows)
// ---------------------------------------------------------------------------

const LEGACY_PROMPT_TEMPLATE = (domain: string, niche: string, style: string) =>
  `Create a complete, professional single-page website HTML file for the domain: ${domain}

Requirements:
- Niche/topic: ${niche}
- Style: ${style}, clean, professional
- Must be a COMPLETE standalone HTML file (HTML, CSS, JS all inline)
- Responsive design (mobile + desktop)
- Include a hero section, features/services section, about section, contact section, footer
- Use modern CSS (flexbox/grid, gradients, smooth transitions)
- Professional color scheme that fits the niche
- Include placeholder text that sounds realistic (not lorem ipsum)
- Add smooth scroll navigation
- The page should look like a real business website
- DO NOT include any external dependencies (no CDN links) — everything inline
- Return ONLY the HTML code, no explanation

Return the complete HTML file starting with <!DOCTYPE html>`

export async function generateWebsite(
  domain: string,
  niche = "general",
  style = "modern",
): Promise<string> {
  logPipeline(domain, "generate_site", "running", `Generating site (${niche}, ${style})`)
  const { provider, apiKey, cliMode } = getLlmConfig()
  const prompt = LEGACY_PROMPT_TEMPLATE(domain, niche, style)
  try {
    let html: string
    if (cliMode) {
      // CLI mode is openai-only now (gemini was removed). codex CLI v0.125+
      // defaults to "gpt-5.5"; let `llm_model` setting override.
      const cliProvider = provider as CliProvider
      const model = getSetting("llm_model") || "gpt-5.5"
      const { text } = await runLlmCli(cliProvider, model, "", prompt)
      html = text
    } else if (provider === "openai") {
      html = await callOpenAiSimple(apiKey, prompt)
    } else {
      html = await callAnthropicSimple(apiKey, prompt)
    }
    const trimmed = html.trim()
    if (!trimmed.startsWith("<!DOCTYPE") && !trimmed.startsWith("<html")) {
      const m = html.match(/<!DOCTYPE html>[\s\S]*?<\/html>/i)
      if (m) html = m[0]
    }
    logPipeline(domain, "generate_site", "completed", `Site generated (${html.length} bytes)`)
    return html
  } catch (e) {
    logPipeline(domain, "generate_site", "failed", (e as Error).message)
    throw e
  }
}

async function callAnthropicSimple(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(getLlmTimeoutMs()),
  })
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = (await res.json()) as { content: { text: string }[] }
  return data.content[0].text
}

async function callOpenAiSimple(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(getLlmTimeoutMs()),
  })
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = (await res.json()) as { choices: { message: { content: string } }[] }
  return data.choices[0].message.content
}

// ---------------------------------------------------------------------------
// V2 — single-call generator with content-safety gate.
//
// The system prompt is now stored in the settings table (key
// `llm_master_prompt`) so the operator can edit it from the dashboard. The
// curated baseline (used when the setting is empty) lives in
// `lib/master-prompt.ts:DEFAULT_MASTER_PROMPT` and bakes in the Google Ads
// compliance sections (Privacy / Terms / Contact / Disclaimer) the operator
// needs for site approval. See `getMasterPrompt(blocklist)` for the read.
// ---------------------------------------------------------------------------

function loadBlocklist(): string[] {
  const raw = getSetting("llm_blocked_niches") || ""
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
    }
  } catch { /* fall through */ }
  return raw.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)
}

function parseModelJson(text: string): Record<string, unknown> | null {
  let t = (text || "").trim()
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
  }
  try { return JSON.parse(t) as Record<string, unknown> } catch { /* try regex extract */ }
  const m = t.match(/\{[\s\S]*\}/)
  if (m) {
    try { return JSON.parse(m[0]) as Record<string, unknown> } catch { /* give up */ }
  }
  return null
}

export interface GeneratedFile {
  /** Path relative to /public_html/, e.g. "index.php", "style.css",
   *  "assets/logo.svg". Validated against `validateGeneratedFiles`. */
  path: string
  content: string
}

interface GeneratedPage {
  inferredNiche: string
  /** The entry-point file content (always populated — this is what step 10
   *  caches in domain.site_html for the migration archive + cache check).
   *  Equals files[entry].content when files is set, else the legacy single
   *  HTML/PHP string. */
  php: string
  /** Optional multi-file output. When present, step 10 uploads ALL files
   *  (the entry point + siblings) instead of just `php`. Always includes
   *  exactly one entry-point file (index.php or index.html). */
  files?: GeneratedFile[]
  /** True when the LLM refused (parsed.blocked) and we substituted the
   *  static placeholder. The caller marks step 9 as "warning" instead of
   *  "completed" so the dashboard's existing Run-from-here button surfaces
   *  on the timeline — without this, a silent placeholder would look like
   *  a successful generation. */
  usedFallback?: boolean
}

/**
 * Sanitize + validate a model-supplied `files` array. Returns the cleaned
 * array on success, or { error } describing the first violation found.
 *
 * Rejects: absolute paths, ".." segments, paths with shell metacharacters,
 * empty content, > 20 files, > 5 directory levels, > 50 KB per file.
 * Requires exactly one of {index.php, index.html} as entry point.
 */
function validateGeneratedFiles(files: unknown): GeneratedFile[] | { error: string } {
  if (!Array.isArray(files)) return { error: "files must be an array" }
  if (files.length === 0) return { error: "files array is empty" }
  if (files.length > 20) return { error: `too many files (${files.length} > max 20)` }

  const out: GeneratedFile[] = []
  let entryPointCount = 0
  // Allowed: lowercase letters, digits, dot, dash, underscore, slash.
  // Uppercase rejected to keep paths predictable on case-insensitive
  // filesystems (Apache resolves URLs case-sensitively even when the FS
  // doesn't, so a model emitting "Index.html" + reference to "index.html"
  // would 404 on Linux).
  const SAFE_PATH = /^[a-zA-Z0-9._\-/]+$/
  const seen = new Set<string>()

  for (const raw of files) {
    if (!raw || typeof raw !== "object") return { error: "file entry must be an object" }
    const f = raw as Record<string, unknown>
    const path = String(f.path ?? "").trim()
    const content = typeof f.content === "string" ? f.content : ""

    if (!path) return { error: "file with empty path" }
    if (!SAFE_PATH.test(path)) return { error: `path '${path}' has unsafe chars` }
    if (path.startsWith("/")) return { error: `path '${path}' must be relative (no leading /)` }
    if (path.includes("..")) return { error: `path '${path}' contains ".." segment` }
    if (path.endsWith("/")) return { error: `path '${path}' looks like a directory, expected file` }
    const segments = path.split("/")
    if (segments.length > 6) return { error: `path '${path}' too deep (max 5 directory levels)` }
    if (segments.some((s) => s.length === 0)) return { error: `path '${path}' has empty segment` }
    if (seen.has(path)) return { error: `duplicate path '${path}'` }
    seen.add(path)

    if (!content) return { error: `file '${path}' has empty content` }
    if (content.length > 50_000) return { error: `file '${path}' too large (${content.length} > 50000 bytes)` }

    if (path === "index.php" || path === "index.html") entryPointCount++
    out.push({ path, content })
  }

  if (entryPointCount === 0) return { error: "files must include exactly one of: index.php, index.html" }
  if (entryPointCount > 1) return { error: "files must include exactly one of: index.php, index.html (both present)" }
  return out
}

interface UsageInfo {
  input_tokens?: number | null
  output_tokens?: number | null
}

export interface GenerateOpts {
  /** Operator-supplied site brief — prepended to the user message as
   *  "Operator brief". Empty / null falls through to default niche
   *  inference from the domain name. */
  customPrompt?: string | null
  /** Override the active provider for this call only. Falls back to the
   *  global `llm_provider` setting when null. */
  customProvider?: string | null
  /** Override the model for this call only. Falls back to `llm_model`
   *  setting, then the per-provider default. */
  customModel?: string | null
}

export async function generateSinglePage(
  domain: string,
  opts: GenerateOpts = {},
): Promise<GeneratedPage> {
  // Cap concurrent LLM calls. Without this, 50 simultaneous step-9s would
  // burst Anthropic's per-account TPM quota and Anthropic returns 429s
  // that look like model "blocked" errors. The semaphore queues callers
  // FIFO so an in-progress run finishes before the next acquires.
  const sem = getSemaphore("llm", LLM_CAP)
  const stats = sem.stats()
  if (stats.inFlight >= stats.capacity) {
    logPipeline(domain, "generate_site_v2", "running",
      `LLM semaphore full (${stats.inFlight}/${stats.capacity}); ` +
      `queued behind ${stats.waiting} other run(s)`)
  }
  return withSemaphore("llm", LLM_CAP, () => _generateSinglePageImpl(domain, opts))
}

async function _generateSinglePageImpl(
  domain: string,
  opts: GenerateOpts = {},
): Promise<GeneratedPage> {
  const { provider, apiKey, cliMode } = getLlmConfig(opts.customProvider ?? null)
  // Per-call model override — falls through to the configured llm_model and
  // then to the per-provider default in each branch below.
  const overrideModel = (opts.customModel ?? "").trim() || null
  const blocklist = loadBlocklist()
  // Output-token cap. 8000 is enough for ~30 KB of HTML (one fat single-page
  // OR ~5-6 small files). Operator can override via llm_max_output_tokens
  // setting in /settings.
  //
  // Auto-bumps:
  //  - long brief (>800 chars, multi-file intent) → 12k
  //  - reasoning model (k2.6, deepseek-r1, qwq, o1/o3) → 16k regardless of
  //    brief length, because reasoning_content burns the budget BEFORE any
  //    answer tokens are emitted. Detected on the resolved model id which
  //    each provider branch computes from `overrideModel ?? llm_model ?? default`.
  const settingRaw = parseInt(getSetting("llm_max_output_tokens") || "", 10)
  const baseTokens = Number.isFinite(settingRaw) && settingRaw > 0 ? settingRaw : 8000
  const briefLen = (opts.customPrompt ?? "").length
  const intendedModel = (overrideModel || getSetting("llm_model") || "").toLowerCase()
  const isReasoningModel = /kimi-k2|deepseek-r1|qwq|reasoning|\bo1\b|\bo3\b/i.test(intendedModel)
  let autoBump = baseTokens
  if (briefLen > 800) autoBump = Math.max(autoBump, 12_000)
  if (isReasoningModel) autoBump = Math.max(autoBump, 16_000)
  const maxTokens = autoBump

  // Master prompt: editable in /settings → LLM → "Master Prompt". Empty
  // setting falls back to lib/master-prompt.ts:DEFAULT_MASTER_PROMPT (which
  // bakes in the Google Ads compliance sections — Privacy / Terms / Contact /
  // Disclaimer — that the curated baseline requires).
  // Re-read on every generation so /settings edits take effect immediately
  // without a worker restart.
  const systemMsg = getMasterPrompt(blocklist)
  // When the operator provides a custom brief (force-rerun on step 9 with
  // textarea input), prepend it as an explicit "Operator brief" so the
  // model treats it as the niche/style intent. The system prompt's safety
  // rules still apply — the brief can shape the page but can't override
  // the blocklist / no-financial-claims / etc. constraints.
  const customBrief = (opts.customPrompt ?? "").trim()
  const userMsg = customBrief
    ? `Operator brief (use this niche / style instead of inferring from the domain name):\n${customBrief}\n\nDomain: ${domain}`
    : `Domain: ${domain}`

  let text = ""
  let usage: UsageInfo = {}

  if (cliMode) {
    // CLI shells out to the user's authenticated `gemini` or `codex` binary.
    // Token usage is not reported (CLIs don't print usageMetadata), so we
    // leave `usage` empty — the row in pipeline_runs just records null.
    const cliProvider = provider as CliProvider
    // CLI mode is openai-only now. codex CLI v0.125 default is "gpt-5.5".
    // Use `||` not `??` — `??` only falls through on null/undefined, but the
    // settings store returns "" for unset model and the override is "" when
    // the dialog field is left blank. We want either of those to fall back.
    const model = (overrideModel || getSetting("llm_model") || "gpt-5.5").trim()
    logPipeline(domain, "generate_site_v2", "running",
      `${cliProvider} CLI call: model=${model}`)
    const { text: cliText } = await runLlmCli(cliProvider, model, systemMsg, userMsg)
    text = cliText
  } else if (provider === "openai" || provider === "openrouter" || provider === "moonshot") {
    let url: string
    let extraHeaders: Record<string, string> = {}
    let defaultModel: string
    if (provider === "openai") {
      // gpt-5-mini is the lightweight current-generation OpenAI model.
      // The earlier "gpt-5.4-mini" hardcoded here was a typo (no such model)
      // and produced 404 / 400 every time the operator hadn't set llm_model.
      defaultModel = "gpt-5-mini"
      url = "https://api.openai.com/v1/chat/completions"
    } else if (provider === "moonshot") {
      // Moonshot Kimi is OpenAI-compatible — same body shape, different host.
      // Default to K2.6 (released 2026-04-20).
      defaultModel = "kimi-k2.6"
      url = "https://api.moonshot.ai/v1/chat/completions"
    } else {
      defaultModel = "google/gemini-2.5-flash"
      url = "https://openrouter.ai/api/v1/chat/completions"
      extraHeaders = {
        "HTTP-Referer": "https://github.com/ssr-project",
        "X-Title": "SSR Site Generator",
      }
    }
    const model = (overrideModel || getSetting("llm_model") || defaultModel).trim()
    logPipeline(domain, "generate_site_v2", "running",
      `${provider} call: model=${model}, max_tokens=${maxTokens}`)
    const tokenField =
      model.startsWith("gpt-5") || model.startsWith("o3") || model.startsWith("o1")
        ? "max_completion_tokens"
        : "max_tokens"
    const body: Record<string, unknown> = {
      model,
      [tokenField]: maxTokens,
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: userMsg },
      ],
      response_format: { type: "json_object" },
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(getLlmTimeoutMs()),
    })
    if (!res.ok) throw new Error(`${provider} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const apiBody = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }
    }
    text = apiBody.choices?.[0]?.message?.content ?? ""
    const u = apiBody.usage ?? {}
    usage = {
      input_tokens: u.prompt_tokens ?? u.input_tokens ?? null,
      output_tokens: u.completion_tokens ?? u.output_tokens ?? null,
    }
  } else if (provider === "cloudflare") {
    // Single-account Cloudflare Workers AI. Uses cloudflare_account_id +
    // cloudflare_workers_ai_token. For multi-account / quota stacking, switch
    // the active provider to "cloudflare_pool".
    const accountId = (getSetting("cloudflare_account_id") || "").trim()
    if (!accountId) {
      throw new Error("cloudflare_account_id is empty — set it in Settings → LLM")
    }
    const model = (overrideModel || getSetting("llm_model") || "@cf/moonshotai/kimi-k2.6").trim()
    logPipeline(domain, "generate_site_v2", "running",
      `cloudflare workers-ai call: model=${model}, max_tokens=${maxTokens}`)
    const out = await callCloudflareWorkersAi({
      accountId, token: apiKey, model, systemMsg, userMsg, maxTokens,
    })
    text = out.text
    usage = out.usage
  } else if (provider === "cloudflare_pool") {
    // Round-robin across cf_workers_ai_keys. Stacks the free 10k-neuron/day
    // quota across every CF account in the pool. On 429 / quota errors we
    // mark last_error on the row and retry with the next-LRU active row.
    const model = (overrideModel || getSetting("llm_model") || "@cf/moonshotai/kimi-k2.6").trim()
    const tried: number[] = []
    let lastErr: Error | null = null
    for (let attempt = 0; attempt < 6; attempt++) {
      let row
      try {
        row = getNextAiKey(tried)
      } catch (e) {
        if (lastErr) throw lastErr
        throw e
      }
      tried.push(row.id)
      logPipeline(domain, "generate_site_v2", "running",
        `cloudflare_pool call: row=#${row.id} (${row.alias ?? row.account_id.slice(0, 6)}) ` +
        `model=${model} max_tokens=${maxTokens} attempt=${attempt + 1}`)
      try {
        const out = await callCloudflareWorkersAi({
          accountId: row.account_id,
          token: row.api_token,
          model, systemMsg, userMsg, maxTokens,
        })
        recordAiKeyCall(row.id)
        text = out.text
        usage = out.usage
        lastErr = null
        break
      } catch (e) {
        const err = e as Error
        recordAiKeyError(row.id, err.message)
        lastErr = err
        // Only retry for quota-shaped failures. Auth / model-id / schema
        // errors won't be helped by the next row, so bail immediately so
        // the operator sees the real cause rather than a generic
        // "all rows failed".
        if (!isCloudflareQuotaError(err.message)) throw err
        logPipeline(domain, "generate_site_v2", "warning",
          `cloudflare_pool row #${row.id} hit quota — falling through to next row`)
      }
    }
    if (lastErr) {
      throw new AiPoolExhausted(
        `cloudflare_pool: all ${tried.length} active row(s) failed; last error: ${lastErr.message}`,
      )
    }
  } else if (provider === "gemini") {
    const model = (overrideModel || getSetting("llm_model") || "gemini-2.5-flash").trim()
    logPipeline(domain, "generate_site_v2", "running",
      `gemini call: model=${model}, max_tokens=${maxTokens}`)
    const body = {
      systemInstruction: { parts: [{ text: systemMsg }] },
      contents: [{ role: "user", parts: [{ text: userMsg }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
        temperature: 0.7,
      },
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(getLlmTimeoutMs()),
      },
    )
    if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const apiBody = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    }
    const cands = apiBody.candidates ?? []
    if (cands.length) {
      const parts = cands[0].content?.parts ?? []
      text = parts.map((p) => p.text ?? "").join("")
    }
    const um = apiBody.usageMetadata ?? {}
    usage = { input_tokens: um.promptTokenCount ?? null, output_tokens: um.candidatesTokenCount ?? null }
  } else {
    // Default / anthropic
    const model = (overrideModel || getSetting("llm_model") || "claude-haiku-4-5-20251001").trim()
    logPipeline(domain, "generate_site_v2", "running",
      `Anthropic call: model=${model}, max_tokens=${maxTokens}`)
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemMsg,
        messages: [{ role: "user", content: userMsg }],
      }),
      signal: AbortSignal.timeout(getLlmTimeoutMs()),
    })
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const apiBody = (await res.json()) as {
      content?: { text?: string }[]
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    text = apiBody.content?.[0]?.text ?? ""
    const u = apiBody.usage ?? {}
    usage = { input_tokens: u.input_tokens ?? null, output_tokens: u.output_tokens ?? null }
  }

  // ---- Parse / validate ---------------------------------------------------
  const parsed = parseModelJson(text)
  if (!parsed) {
    const m = text.match(/<!DOCTYPE html>[\s\S]*?<\/html>/i)
    if (m) {
      logPipeline(domain, "generate_site_v2", "warning",
        "Model returned raw HTML, not JSON — accepting")
      return { inferredNiche: "", php: m[0] }
    }
    throw new Error(`Model response not parseable as JSON. Raw head: ${text.slice(0, 300)}`)
  }

  if (parsed.blocked) {
    // Model went through its baked-in safety layer despite the "never refuse"
    // prompt. Don't fail the pipeline — drop in a static brand-neutral
    // placeholder page locally and continue. The site is still LIVE; the
    // operator can later replace it with custom content if desired.
    const reason = String(parsed.reason ?? "blocked by content policy")
    const niche = String(parsed.inferred_niche ?? "")
    const fallbackPhp = renderFallbackPage(domain)
    logPipeline(domain, "generate_site_v2", "warning",
      `Model refused (niche='${niche}' reason='${reason.slice(0, 200)}') — substituting ` +
      `static placeholder so the pipeline can continue`)
    return { inferredNiche: niche || "placeholder", php: fallbackPhp, usedFallback: true }
  }

  const niche = String(parsed.inferred_niche ?? "")

  // Multi-file envelope (B): the model returned `files: [...]`. Validate the
  // path tree, scan every file's content for dangerous patterns, then pick
  // the entry-point file's content as the canonical `php` (cached in
  // domain.site_html for legacy migration / cache check).
  if (parsed.files !== undefined) {
    const v = validateGeneratedFiles(parsed.files)
    if ("error" in v) {
      throw new Error(`Generator returned invalid files array: ${v.error}`)
    }
    for (const f of v) scanForDangerousContent(domain, f.content)
    const entry = v.find((f) => f.path === "index.php") ?? v.find((f) => f.path === "index.html")!
    const totalBytes = v.reduce((n, f) => n + f.content.length, 0)
    logPipeline(domain, "generate_site_v2", "completed",
      `niche='${niche}'  files=${v.length} (${v.map((f) => f.path).join(", ")})  ` +
      `total_bytes=${totalBytes}  ` +
      `input_tokens=${usage.input_tokens ?? ""}  output_tokens=${usage.output_tokens ?? ""}`)
    return { inferredNiche: niche, php: entry.content, files: v }
  }

  // Legacy single-string envelope (A) — accept `php` or `html` field name.
  const php = String((parsed.php ?? parsed.html ?? "") as string)
  if (!php || (!php.includes("<!DOCTYPE") && !php.includes("<html"))) {
    throw new Error(
      `Generator returned empty or malformed html. Parsed keys: ${Object.keys(parsed).join(", ")}`,
    )
  }

  scanForDangerousContent(domain, php)

  logPipeline(domain, "generate_site_v2", "completed",
    `niche='${niche}'  bytes=${php.length}  ` +
    `input_tokens=${usage.input_tokens ?? ""}  output_tokens=${usage.output_tokens ?? ""}`)
  return { inferredNiche: niche, php }
}

// ---------------------------------------------------------------------------
// Dangerous-output scanner — defends against prompt-injection-driven XSS
// ---------------------------------------------------------------------------

const DANGEROUS_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /document\.cookie/i, name: "cookie-stealer sig" },
  { pattern: /eval\s*\(\s*atob/i, name: "eval(atob(...)) payload signature" },
  { pattern: /\bnew\s+Function\s*\(/i, name: "dynamic code execution via Function()" },
  { pattern: /<iframe[^>]*src=["']https?:\/\/(?:\d+\.){3}\d+/i, name: "iframe pointing at raw IP" },
  { pattern: /<script[^>]*src=["']https?:\/\/(?:\d+\.){3}\d+/i, name: "script src pointing at raw IP" },
  { pattern: /window\.location\.href\s*=\s*["']https?:\/\/[^"'/]*\.(?:ru|tk|xyz)/i,
    name: "redirect to suspicious TLD" },
  { pattern: /\.innerHTML\s*=\s*["']<script/i, name: "innerHTML injecting script tag" },
]

function scanForDangerousContent(domain: string, content: string): void {
  const matches = DANGEROUS_PATTERNS.filter((p) => p.pattern.test(content)).map((p) => p.name)
  if (matches.length) {
    const reason = `generated content contained suspicious pattern(s): ${matches.join(", ")}`
    logPipeline(domain, "generate_site_v2", "blocked", `LLM output REJECTED — ${reason}`)
    throw new ContentBlockedError(reason, "suspicious_output")
  }
}

// ---------------------------------------------------------------------------
// Static fallback page — used when the LLM refuses despite the "never refuse"
// prompt. Brand-neutral "Welcome / Coming Soon" template that name-checks the
// domain but says NOTHING about the inferred niche. Always under 5KB, fully
// self-contained, no external assets, no JS.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] ?? c),
  )
}

function renderFallbackPage(domain: string): string {
  const safe = escapeHtml(domain)
  // Pick a brand letter from the domain for the hero monogram
  const letter = (domain.replace(/[^A-Za-z]/g, "")[0] ?? "S").toUpperCase()
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safe} — Coming Soon</title>
<style>
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#1f2937;background:linear-gradient(135deg,#f8fafc 0%,#eef2ff 100%);min-height:100vh;display:flex;flex-direction:column}
.wrap{flex:1;display:flex;flex-direction:column;justify-content:center;max-width:760px;margin:0 auto;padding:48px 24px}
.mono{display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:14px;background:linear-gradient(135deg,#6366f1,#3b82f6);color:#fff;font-weight:700;font-size:30px;letter-spacing:-1px;margin-bottom:24px;box-shadow:0 4px 14px rgba(59,130,246,.3)}
h1{font-size:clamp(32px,5vw,44px);line-height:1.15;letter-spacing:-0.02em;margin:0 0 16px;font-weight:700}
.tag{color:#6366f1;font-weight:600;font-size:14px;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 12px}
.lead{font-size:18px;line-height:1.6;color:#475569;margin:0 0 32px;max-width:560px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:0 0 40px}
.card{background:#fff;border-radius:12px;padding:20px;border:1px solid #e2e8f0}
.card h3{font-size:15px;margin:0 0 6px;font-weight:600;color:#0f172a}
.card p{font-size:14px;line-height:1.5;color:#64748b;margin:0}
footer{padding:24px;text-align:center;color:#94a3b8;font-size:13px;border-top:1px solid #e2e8f0;background:#fff}
footer a{color:#6366f1;text-decoration:none}
</style>
</head>
<body>
<main class="wrap">
<div class="mono">${letter}</div>
<p class="tag">Now Building</p>
<h1>${safe}</h1>
<p class="lead">We're putting the finishing touches on something new. Check back soon to see what we've been working on, or get in touch if you'd like to be notified when we launch.</p>
<div class="grid">
<div class="card"><h3>What's coming</h3><p>A clean, focused experience designed around what matters most to the people who'll use it.</p></div>
<div class="card"><h3>Built with care</h3><p>Thoughtful design, fast pages, and an attention to the small details you usually only notice when they're missing.</p></div>
<div class="card"><h3>Stay in touch</h3><p>If you'd like to follow along, drop us a line at hello@${safe} and we'll let you know when we're live.</p></div>
</div>
</main>
<footer>© ${new Date().getFullYear()} ${safe} · all rights reserved · <a href="mailto:hello@${safe}">hello@${safe}</a></footer>
</body>
</html>`
}
