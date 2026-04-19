"""
LLM-powered single-page website generator.
Uses Claude API (or any configured LLM) to create unique landing pages per domain.
"""

import requests
from database import get_setting, log_pipeline


def _get_llm_config():
    """Return (provider, api_key) tuple.

    Looks up the per-provider key first (e.g. llm_api_key_openai,
    llm_api_key_gemini, ...), and falls back to the generic `llm_api_key`
    for backward compat with single-provider deployments.
    """
    provider = (get_setting("llm_provider") or "anthropic").strip().lower()
    per_provider = get_setting(f"llm_api_key_{provider}") or ""
    api_key = per_provider or get_setting("llm_api_key") or ""
    if not api_key:
        raise ValueError(
            f"No API key set for provider '{provider}'. "
            f"Paste one into Settings → llm_api_key_{provider} (or the generic llm_api_key)."
        )
    return provider, api_key


def generate_website(domain, niche="general", style="modern"):
    """
    Generate a complete single-page HTML website for the given domain.
    Returns the full HTML string ready to deploy.
    """
    log_pipeline(domain, "generate_site", "running", f"Generating site ({niche}, {style})")
    provider, api_key = _get_llm_config()

    prompt = f"""Create a complete, professional single-page website HTML file for the domain: {domain}

Requirements:
- Niche/topic: {niche}
- Style: {style}, clean, professional
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

Return the complete HTML file starting with <!DOCTYPE html>"""

    try:
        if provider == "anthropic":
            html = _call_anthropic(api_key, prompt)
        elif provider == "openai":
            html = _call_openai(api_key, prompt)
        else:
            html = _call_anthropic(api_key, prompt)

        if not html.strip().startswith("<!DOCTYPE") and not html.strip().startswith("<html"):
            # Try to extract HTML from response
            import re
            match = re.search(r'(<!DOCTYPE html>.*</html>)', html, re.DOTALL | re.IGNORECASE)
            if match:
                html = match.group(1)

        log_pipeline(domain, "generate_site", "completed", f"Site generated ({len(html)} bytes)")
        return html

    except Exception as e:
        log_pipeline(domain, "generate_site", "failed", str(e))
        raise


def _call_anthropic(api_key, prompt):
    """Call Claude API."""
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
        },
        json={
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 8000,
            "messages": [{"role": "user", "content": prompt}]
        },
        timeout=120
    )
    resp.raise_for_status()
    data = resp.json()
    return data["content"][0]["text"]


def _call_openai(api_key, prompt):
    """Call OpenAI API."""
    resp = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        },
        json={
            "model": "gpt-4o",
            "max_tokens": 8000,
            "messages": [{"role": "user", "content": prompt}]
        },
        timeout=120
    )
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"]


# ============================================================================
#  NEW (v2 pipeline) — single-call Haiku generator with content-safety gate
# ============================================================================

import json as _json
import re as _re


class ContentBlockedError(Exception):
    """Raised when the inferred niche matches a blocked category.

    Pipeline catches this and marks the domain as content_blocked (non-retryable).
    """
    def __init__(self, reason, inferred_niche=""):
        super().__init__(reason)
        self.reason = reason
        self.inferred_niche = inferred_niche


_GEN_SYSTEM_PROMPT = """You are a fast single-page website generator.

Given a domain name, you must:
 1. Infer the intended topic/niche from the domain name alone.
 2. Decide whether that topic falls into ANY of these prohibited categories
    (Google Ads-restricted or high-risk): {blocklist}
 3. RESPOND WITH JSON ONLY — no markdown fences, no prose before or after.

Two possible JSON shapes:

A) If the inferred topic is in a prohibited category:
   {{"blocked": true, "inferred_niche": "<short description>", "reason": "<which category and why>"}}

B) If the topic is SAFE:
   {{"blocked": false, "inferred_niche": "<short description>", "php": "<complete single-page content>"}}

For (B), the "php" field must contain a COMPLETE self-contained HTML page:
 - Starts with <!DOCTYPE html>
 - All CSS inline in <style>, no external dependencies (no CDNs, no <link>)
 - Responsive (mobile + desktop) using CSS flex/grid
 - Under 5 KB gzipped total
 - One hero + 2-3 content sections + a simple footer
 - Realistic copy about the inferred topic (no Lorem Ipsum)
 - Tasteful color scheme matching the niche

Keep it compact. Do NOT include any JavaScript unless strictly necessary.
Respond with the JSON object and nothing else."""


def _load_blocklist():
    raw = get_setting("llm_blocked_niches") or ""
    if not raw:
        return []
    try:
        parsed = _json.loads(raw)
        if isinstance(parsed, list):
            return [str(x).strip().lower() for x in parsed if str(x).strip()]
    except Exception:
        pass
    # fallback: comma-separated
    return [x.strip().lower() for x in raw.split(",") if x.strip()]


def _parse_model_json(text):
    """Best-effort JSON extraction from the model's reply."""
    text = (text or "").strip()
    # Strip common ```json fences if present
    if text.startswith("```"):
        text = _re.sub(r"^```(?:json)?\s*", "", text)
        text = _re.sub(r"\s*```$", "", text)
    # Try direct parse first
    try:
        return _json.loads(text)
    except Exception:
        pass
    # Extract the largest {...} block
    m = _re.search(r"\{.*\}", text, flags=_re.DOTALL)
    if m:
        try:
            return _json.loads(m.group(0))
        except Exception:
            pass
    return None


def generate_single_page(domain):
    """Single-call generator with content-safety gate. Provider-aware.

    Routes to either Anthropic (Claude Haiku 4.5 default) or OpenAI
    (gpt-5.4-mini default) based on the `llm_provider` setting.

    Infers the niche from the domain, checks it against the project's
    blocklist, and (if safe) returns a complete single-page HTML that
    can be dropped into an index.php file.

    Returns:
      {"inferred_niche": str, "php": str}     ← on success
    Raises:
      ContentBlockedError                     ← if niche is prohibited
      RuntimeError / requests.HTTPError       ← on API/network failure
    """
    provider, api_key = _get_llm_config()
    blocklist = _load_blocklist()
    try:
        max_tokens = int(get_setting("llm_max_output_tokens") or 3500)
    except (TypeError, ValueError):
        max_tokens = 3500

    system_msg = _GEN_SYSTEM_PROMPT.format(blocklist=", ".join(blocklist))
    user_msg = f"Domain: {domain}"

    if provider in ("openai", "openrouter"):
        # OpenRouter exposes an OpenAI-compatible Chat Completions endpoint,
        # so one code path serves both with different base URL + model prefix.
        if provider == "openai":
            default_model = "gpt-5.4-mini"
            url = "https://api.openai.com/v1/chat/completions"
            extra_headers = {}
        else:
            default_model = "google/gemini-2.5-flash"  # sensible cheap OpenRouter default
            url = "https://openrouter.ai/api/v1/chat/completions"
            # OpenRouter etiquette: identify the caller via HTTP-Referer
            extra_headers = {
                "HTTP-Referer": "https://github.com/ssr-project",
                "X-Title": "SSR Site Generator",
            }

        model = get_setting("llm_model") or default_model
        log_pipeline(domain, "generate_site_v2", "running",
                     f"{provider} call: model={model}, max_tokens={max_tokens}")
        # GPT-5.x / o1 / o3 require `max_completion_tokens`.
        token_field = "max_completion_tokens" if model.startswith(("gpt-5", "o3", "o1")) else "max_tokens"
        body = {
            "model": model,
            token_field: max_tokens,
            "messages": [
                {"role": "system", "content": system_msg},
                {"role": "user", "content": user_msg},
            ],
            # Force JSON output so we don't regex-parse prose
            "response_format": {"type": "json_object"},
        }
        resp = requests.post(
            url,
            headers={"Authorization": f"Bearer {api_key}",
                     "Content-Type": "application/json",
                     **extra_headers},
            json=body,
            timeout=120,
        )
        resp.raise_for_status()
        api_body = resp.json()
        text = (api_body.get("choices") or [{}])[0].get("message", {}).get("content", "")
        usage = api_body.get("usage") or {}
        usage = {
            "input_tokens": usage.get("prompt_tokens") or usage.get("input_tokens"),
            "output_tokens": usage.get("completion_tokens") or usage.get("output_tokens"),
        }

    elif provider == "gemini":
        # Google AI Studio REST API — different shape, API key in query string.
        model = get_setting("llm_model") or "gemini-2.5-flash"
        log_pipeline(domain, "generate_site_v2", "running",
                     f"gemini call: model={model}, max_tokens={max_tokens}")
        body = {
            "systemInstruction": {"parts": [{"text": system_msg}]},
            "contents": [{"role": "user", "parts": [{"text": user_msg}]}],
            "generationConfig": {
                "maxOutputTokens": max_tokens,
                "responseMimeType": "application/json",
                "temperature": 0.7,
            },
        }
        resp = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            headers={"Content-Type": "application/json",
                     "x-goog-api-key": api_key},
            json=body,
            timeout=120,
        )
        resp.raise_for_status()
        api_body = resp.json()
        # Gemini response: candidates[0].content.parts[0].text
        cands = api_body.get("candidates") or []
        text = ""
        if cands:
            parts = ((cands[0].get("content") or {}).get("parts") or [])
            text = "".join(p.get("text", "") for p in parts)
        um = api_body.get("usageMetadata") or {}
        usage = {
            "input_tokens": um.get("promptTokenCount"),
            "output_tokens": um.get("candidatesTokenCount"),
        }

    else:
        # Default / anthropic
        model = get_setting("llm_model") or "claude-haiku-4-5-20251001"
        log_pipeline(domain, "generate_site_v2", "running",
                     f"Anthropic call: model={model}, max_tokens={max_tokens}")
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": model,
                "max_tokens": max_tokens,
                "system": system_msg,
                "messages": [{"role": "user", "content": user_msg}],
            },
            timeout=120,
        )
        resp.raise_for_status()
        api_body = resp.json()
        text = (api_body.get("content") or [{}])[0].get("text", "")
        usage = api_body.get("usage") or {}

    parsed = _parse_model_json(text)
    if not isinstance(parsed, dict):
        # Last-resort: try to extract raw HTML even when the model skipped JSON
        m = _re.search(r"<!DOCTYPE html>.*?</html>", text, flags=_re.DOTALL | _re.IGNORECASE)
        if m:
            log_pipeline(domain, "generate_site_v2", "warning",
                         "Model returned raw HTML, not JSON — accepting")
            return {"inferred_niche": "", "php": m.group(0)}
        raise RuntimeError(f"Model response not parseable as JSON. Raw head: {text[:300]}")

    if parsed.get("blocked"):
        reason = str(parsed.get("reason") or "blocked by content policy")
        niche = str(parsed.get("inferred_niche") or "")
        log_pipeline(domain, "generate_site_v2", "blocked",
                     f"Content-blocked niche='{niche}'  reason={reason}")
        raise ContentBlockedError(reason, inferred_niche=niche)

    php = parsed.get("php") or parsed.get("html") or ""
    niche = str(parsed.get("inferred_niche") or "")
    if not php or ("<!DOCTYPE" not in php and "<html" not in php):
        raise RuntimeError(f"Generator returned empty or malformed html. Parsed keys: {list(parsed.keys())}")

    # Issue #8: scan the generated content for obvious malicious signatures
    # before we upload it as a live website. If the LLM produced output that
    # looks like prompt-injection-derived XSS / credential harvesting, BLOCK
    # the upload. These are "smell test" patterns — they won't catch every
    # sneaky attack but they catch the obvious wins.
    _scan_for_dangerous_content(domain, php)

    log_pipeline(domain, "generate_site_v2", "completed",
                 f"niche='{niche}'  bytes={len(php)}  "
                 f"input_tokens={usage.get('input_tokens')}  output_tokens={usage.get('output_tokens')}")
    return {"inferred_niche": niche, "php": php}


# Signatures we DO NOT want an LLM-generated promotional website to contain.
# These are flagged/blocked at generation time so they never reach visitors.
# Kept deliberately short — false positives are worse than a rare miss,
# since every block forces a re-gen.
_DANGEROUS_PATTERNS = [
    (r"document\.cookie", "cookie-stealer sig"),
    (r"eval\s*\(\s*atob", "eval(atob(...)) payload signature"),
    (r"\bnew\s+Function\s*\(", "dynamic code execution via Function()"),
    (r"<iframe[^>]*src=[\"']https?://(?:\d+\.){3}\d+", "iframe pointing at raw IP"),
    (r"<script[^>]*src=[\"']https?://(?:\d+\.){3}\d+", "script src pointing at raw IP"),
    (r"window\.location\.href\s*=\s*[\"']https?://[^\"'/]*\.(?:ru|tk|xyz)",
     "redirect to suspicious TLD"),
    (r"\.innerHTML\s*=\s*[\"']<script",
     "innerHTML injecting script tag"),
]


def _scan_for_dangerous_content(domain: str, content: str) -> None:
    """Raise ContentBlockedError if content contains any _DANGEROUS_PATTERNS.
    Logs the matched signature so the user can see exactly why."""
    import re
    matches = [name for pat, name in _DANGEROUS_PATTERNS
               if re.search(pat, content, re.IGNORECASE)]
    if matches:
        reason = ("generated content contained suspicious pattern(s): " +
                  ", ".join(matches))
        log_pipeline(domain, "generate_site_v2", "blocked",
                     f"LLM output REJECTED — {reason}")
        raise ContentBlockedError(reason, inferred_niche="suspicious_output")
