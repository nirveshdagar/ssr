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
import { logPipeline } from "./repos/logs"

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

interface LlmConfig {
  provider: string
  apiKey: string
}

function getLlmConfig(): LlmConfig {
  const provider = (getSetting("llm_provider") || "anthropic").trim().toLowerCase()
  const perProvider = getSetting(`llm_api_key_${provider}`) || ""
  const apiKey = perProvider || getSetting("llm_api_key") || ""
  if (!apiKey) {
    throw new Error(
      `No API key set for provider '${provider}'. ` +
      `Paste one into Settings → llm_api_key_${provider} (or the generic llm_api_key).`,
    )
  }
  return { provider, apiKey }
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
  const { provider, apiKey } = getLlmConfig()
  const prompt = LEGACY_PROMPT_TEMPLATE(domain, niche, style)
  try {
    let html: string
    if (provider === "openai") {
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
    signal: AbortSignal.timeout(120_000),
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
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = (await res.json()) as { choices: { message: { content: string } }[] }
  return data.choices[0].message.content
}

// ---------------------------------------------------------------------------
// V2 — single-call generator with content-safety gate
// ---------------------------------------------------------------------------

const GEN_SYSTEM_PROMPT = (blocklist: string) => `You are a fast single-page website generator. ALWAYS produce a complete marketing/landing page. NEVER refuse based on what the domain name suggests — every domain gets a page.

How to interpret the domain:
 - Read the domain, pick a plausible benign interpretation (a brand name, a placeholder business, a generic informational topic).
 - If a LITERAL reading would land in a restricted category${blocklist ? ` (e.g. ${blocklist})` : ""}, do NOT refuse — instead PIVOT the page to a brand-neutral "About / Coming Soon / Welcome" template that mentions the name only as a brand, not the niche. The site you generate is your responsibility, not the domain's apparent meaning.

Content rules (apply to EVERY page you generate):
 - Generic, informational, brand-neutral tone. No specific claims, no calls to action that could be regulated.
 - NO financial product claims (rates, returns, loans, credit-repair, crypto investment).
 - NO medical, health, or supplement claims.
 - NO gambling / casino / betting / lottery references.
 - NO adult, political, controversial, drug, weapon, or other regulated-category content.
${blocklist ? ` - Also avoid generating content about: ${blocklist}.\n` : ""}
RESPOND WITH JSON ONLY — no markdown fences, no prose before or after:

   {"inferred_niche": "<short safe description of the page YOU generated>", "php": "<complete single-page content>"}

The "php" field must contain a COMPLETE self-contained HTML page:
 - Starts with <!DOCTYPE html>
 - All CSS inline in <style>, no external dependencies (no CDNs, no <link>)
 - Responsive (mobile + desktop) using CSS flex/grid
 - Under 5 KB gzipped total
 - One hero + 2-3 content sections + a simple footer
 - Realistic copy (no Lorem Ipsum)
 - Tasteful color scheme

Keep it compact. Do NOT include any JavaScript unless strictly necessary.
Respond with the JSON object and nothing else. Do NOT include a "blocked" field.`

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

interface GeneratedPage {
  inferredNiche: string
  php: string
}

interface UsageInfo {
  input_tokens?: number | null
  output_tokens?: number | null
}

export async function generateSinglePage(domain: string): Promise<GeneratedPage> {
  const { provider, apiKey } = getLlmConfig()
  const blocklist = loadBlocklist()
  const maxTokensRaw = parseInt(getSetting("llm_max_output_tokens") || "3500", 10)
  const maxTokens = Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? maxTokensRaw : 3500

  const systemMsg = GEN_SYSTEM_PROMPT(blocklist.join(", "))
  const userMsg = `Domain: ${domain}`

  let text = ""
  let usage: UsageInfo = {}

  if (provider === "openai" || provider === "openrouter") {
    let url: string
    let extraHeaders: Record<string, string> = {}
    let defaultModel: string
    if (provider === "openai") {
      defaultModel = "gpt-5.4-mini"
      url = "https://api.openai.com/v1/chat/completions"
    } else {
      defaultModel = "google/gemini-2.5-flash"
      url = "https://openrouter.ai/api/v1/chat/completions"
      extraHeaders = {
        "HTTP-Referer": "https://github.com/ssr-project",
        "X-Title": "SSR Site Generator",
      }
    }
    const model = getSetting("llm_model") || defaultModel
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
      signal: AbortSignal.timeout(120_000),
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
  } else if (provider === "gemini") {
    const model = getSetting("llm_model") || "gemini-2.5-flash"
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
        signal: AbortSignal.timeout(120_000),
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
    const model = getSetting("llm_model") || "claude-haiku-4-5-20251001"
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
      signal: AbortSignal.timeout(120_000),
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
    return { inferredNiche: niche || "placeholder", php: fallbackPhp }
  }

  const php = String((parsed.php ?? parsed.html ?? "") as string)
  const niche = String(parsed.inferred_niche ?? "")
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
