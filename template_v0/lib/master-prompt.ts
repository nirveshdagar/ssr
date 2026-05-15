/**
 * Master prompt storage + reader for the AI Site Generator.
 *
 * The pipeline's step 9 (LLM site generation) used to embed the system
 * prompt as a hardcoded constant in `lib/website-generator.ts`. That was
 * fine while the prompt was a one-shot constant, but operators legitimately
 * want to:
 *   1. Edit the prompt without redeploying
 *   2. Track versions (which run used which prompt?)
 *   3. Roll back when a new prompt produces worse output
 *   4. Reset to the curated default
 *
 * This module backs the editor in /settings + the /ai-generator page.
 * `llm_master_prompt` lives in the settings table; on every save we ALSO
 * append a row to `llm_master_prompt_history` so the operator can see the
 * progression and (later) restore an older version.
 *
 * Schema is self-bootstrapped (CREATE TABLE IF NOT EXISTS) so this v8-
 * dashboard-only feature doesn't depend on Flask's init_db running first.
 */
import { all, getDb, one, run } from "./db"
import { getSetting, setSetting } from "./repos/settings"

let schemaReady = false

function ensureSchema(): void {
  if (schemaReady) return
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS llm_master_prompt_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      version     INTEGER NOT NULL,
      content     TEXT NOT NULL,
      saved_at    TEXT NOT NULL DEFAULT (datetime('now')),
      saved_by    TEXT,
      reset       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_master_prompt_history_version
      ON llm_master_prompt_history(version DESC);
  `)
  schemaReady = true
}

// ---------------------------------------------------------------------------
// Default prompt — the curated baseline shown when llm_master_prompt is
// empty AND when the operator clicks "Reset to default" in the editor.
// ---------------------------------------------------------------------------

/**
 * Curated default prompt with Google Ads compliance baked in. Differences
 * from the original hardcoded one in website-generator.ts:
 *   - Demands Privacy Policy / Terms / Contact / Disclaimer (modal OR section)
 *     so the generated site can pass Google Ads' destination requirements.
 *   - Requires real-looking contact details + named navigation links.
 *   - Static-host hosting constraints (Apache, no Node/Next, CDN <link>
 *     allowed) — same as the multi-file prompt rev.
 *   - Two response shapes (single-page or multi-file) — same as today.
 *
 * `{{NICHE_BLOCKLIST}}` is substituted at runtime (empty if no blocklist).
 */
export const DEFAULT_MASTER_PROMPT = `You are a professional website generator producing PRODUCTION-READY single-page marketing sites for static Apache hosting. ALWAYS produce a complete site. NEVER refuse based on what the domain name suggests — every domain gets a page.

How to interpret the domain:
 - Read the domain, pick a plausible benign interpretation (a brand name, a placeholder business, a generic informational topic).
 - If a LITERAL reading would land in a restricted category{{NICHE_BLOCKLIST}}, do NOT refuse — instead PIVOT the page to a brand-neutral "About / Coming Soon / Welcome" template that mentions the name only as a brand, not the niche.

Hosting environment (HARD CONSTRAINTS):
 - Apache + PHP shared hosting. NO Node, NO Next.js, NO npm install, NO build step.
 - If the operator's brief mentions Next.js / React / Tailwind / Framer Motion / a build pipeline, IGNORE the framework choice and produce equivalent STATIC HTML+CSS+vanilla-JS that approximates the look.
 - You may inline frontend libraries from a CDN (\`<link rel="stylesheet">\` for Tailwind Play, AlpineJS for interactivity, etc.) — that IS allowed if it materially helps the look.

Required page sections (EVERY generated site MUST include all of these):
 1. **Header / Navigation** — site name, logo glyph, anchor links to each section, mobile-friendly hamburger optional.
 2. **Hero** — headline + subheadline + primary CTA. Real, niche-relevant copy.
 3. **About** — 2-3 paragraphs. Concrete, named details. No Lorem Ipsum.
 4. **Services / Content** — 3-6 cards with icons (inline SVG or emoji), real headings, concrete benefit copy.
 5. **Contact** — name, generic email like \`hello@<domain>\`, plausible phone format, plausible street address (city + state, no real PII), simple contact form (HTML only, no submit handler — Apache static).
 6. **Footer** — copyright, link list (Privacy, Terms, Contact, Disclaimer), social icons (visual only, no real handles).

Required compliance sections (Google Ads policy — sites without these get rejected):
 - **Privacy Policy** — what data the site collects (cookies / contact form fields), how it's used, how to opt out, GDPR/CCPA mention.
 - **Terms & Conditions** — acceptance of terms, intellectual-property clause, limitation of liability, governing-law placeholder.
 - **Contact Us** — explicit contact section as above (separate from the footer link).
 - **Disclaimer** — informational-only / not professional advice / external-links / no warranty.

Compliance sections may be implemented EITHER as:
 (a) Separate sections on the same page (linked from the footer), OR
 (b) Modal dialogs / expandable details that open when the footer link is clicked.

Both are acceptable. Pick whichever fits the design.

Content rules (apply to EVERY page you generate):
 - Generic, informational, brand-neutral tone. No specific medical / legal / financial / regulated claims.
 - NO financial product claims (rates, returns, loans, credit-repair, crypto investment).
 - NO medical, health, or supplement claims.
 - NO gambling / casino / betting / lottery references.
 - NO adult, political, controversial, drug, weapon, or other regulated-category content.{{NICHE_BLOCKLIST_RULE}}

Quality bar (so Google Ads doesn't reject as "thin content"):
 - Substantive copy: hero subhead 15-25 words, About 80-120 words, every Services card 25-40 words.
 - Specific (not generic) benefits — name the use case / customer / scenario.
 - Real-looking testimonials (2-3) with first name + last initial + city.
 - Realistic FAQ (3-5 entries) — actual questions, actual answers.
 - Tasteful color palette (not garish). Mobile-responsive (CSS flex/grid).
 - Heading hierarchy: ONE h1, multiple h2s, h3s under each section.

RESPOND WITH JSON ONLY — no markdown fences, no prose before or after.

You may pick ONE of these two response shapes:

  (A) Single-page (preferred — easier to deploy):
      {"inferred_niche": "<short description>", "php": "<complete single-page HTML>"}
      The "php" field is a COMPLETE self-contained HTML page (DOCTYPE → </html>),
      with ALL required sections + ALL compliance sections inlined.

  (B) Multi-file (use when separate stylesheets / pages help — e.g. a
      privacy.html linked from the footer instead of a modal):
      {"inferred_niche": "<short description>", "files": [
         {"path": "index.php",      "content": "<full HTML — entry point>"},
         {"path": "style.css",      "content": "<css>"},
         {"path": "privacy.html",   "content": "<full HTML — Privacy Policy>"},
         {"path": "terms.html",     "content": "<full HTML — Terms>"},
         {"path": "disclaimer.html","content": "<full HTML — Disclaimer>"},
         {"path": "assets/logo.svg","content": "<svg>"}
      ]}
      Rules for "files":
       - MUST include exactly one of: "index.php" or "index.html" (entry point).
       - Paths relative to /public_html/. NO leading slash. NO ".." segments.
       - Allowed chars: a-z A-Z 0-9 . - _ /  (lowercase preferred).
       - Max 20 files total. Max 5 directory components deep. Max 50 KB per file.
       - text content only — no binary assets (no images/fonts as base64).
       - Footer links to compliance pages must use relative URLs ("privacy.html", "terms.html").

Pick (A) for simple briefs / Coming-Soon pages. Pick (B) when separate compliance pages improve the design.
Respond with the JSON object and nothing else. Do NOT include a "blocked" field.`

// ---------------------------------------------------------------------------
// Public read / write
// ---------------------------------------------------------------------------

/**
 * Apply blocklist placeholder substitution to an arbitrary master-prompt
 * template. Extracted so per-run override code paths (the per-domain
 * Regenerate dialog's editable master prompt) get the same substitution
 * without going through the global getter.
 */
export function substituteMasterPromptPlaceholders(template: string, blocklist: string[] = []): string {
  const blocklistInline = blocklist.length ? ` (e.g. ${blocklist.join(", ")})` : ""
  const blocklistRule = blocklist.length
    ? `\n - Also avoid generating content about: ${blocklist.join(", ")}.\n`
    : ""
  return template
    .replaceAll("{{NICHE_BLOCKLIST}}", blocklistInline)
    .replaceAll("{{NICHE_BLOCKLIST_RULE}}", blocklistRule)
}

/**
 * Resolve the prompt the LLM should use for a generation. Substitutes the
 * blocklist placeholders. Call this from `_generateSinglePageImpl` on every
 * generation so prompt edits in /settings take effect immediately (no
 * dev-server restart needed).
 */
export function getMasterPrompt(blocklist: string[] = []): string {
  ensureSchema()
  const stored = (getSetting("llm_master_prompt") ?? "").trim()
  const template = stored || DEFAULT_MASTER_PROMPT
  return substituteMasterPromptPlaceholders(template, blocklist)
}

export interface PromptHistoryRow {
  id: number
  version: number
  content: string
  saved_at: string
  saved_by: string | null
  reset: number
}

export interface PromptStatus {
  /** The currently-active prompt content (empty string = using default). */
  content: string
  /** True when the operator has not customized it yet. */
  is_default: boolean
  /** Default content (for "reset" UX or diff comparison). */
  default_content: string
  /** Bumped by 1 on every save. Starts at 0 when no overrides exist. */
  version: number
  /** ISO8601, last save timestamp. Null when default. */
  last_saved_at: string | null
  /** How many history rows we've kept (max 50, trimmed). */
  history_count: number
}

export function getMasterPromptStatus(): PromptStatus {
  ensureSchema()
  const stored = (getSetting("llm_master_prompt") ?? "").trim()
  const isDefault = stored === ""
  const versionRaw = parseInt(getSetting("llm_master_prompt_version") ?? "", 10)
  const version = Number.isFinite(versionRaw) && versionRaw > 0 ? versionRaw : 0
  const lastSavedAt = getSetting("llm_master_prompt_saved_at") || null
  const historyRow = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM llm_master_prompt_history",
  )
  return {
    content: stored,
    is_default: isDefault,
    default_content: DEFAULT_MASTER_PROMPT,
    version,
    last_saved_at: lastSavedAt,
    history_count: historyRow?.n ?? 0,
  }
}

const HISTORY_MAX = 50

/**
 * Save a new master prompt. Appends a history row, bumps the version
 * counter, stamps last-saved-at. Trims history to HISTORY_MAX rows.
 *
 * Empty string `content` is treated as "reset to default" — clears the
 * setting so subsequent generations use DEFAULT_MASTER_PROMPT, but still
 * appends a `reset=1` row to history so the trail is preserved.
 */
export function setMasterPrompt(content: string, savedBy: string | null = null): PromptStatus {
  ensureSchema()
  const trimmed = (content ?? "").trim()
  const isReset = trimmed.length === 0
  const versionRaw = parseInt(getSetting("llm_master_prompt_version") ?? "", 10)
  const nextVersion = (Number.isFinite(versionRaw) && versionRaw > 0 ? versionRaw : 0) + 1
  const nowIso = new Date().toISOString().slice(0, 19).replace("T", " ")
  setSetting("llm_master_prompt", trimmed)
  setSetting("llm_master_prompt_version", String(nextVersion))
  setSetting("llm_master_prompt_saved_at", nowIso)
  // Persist the SAVED content (or DEFAULT if reset) so the history can
  // diff/restore. Cheaper than re-deriving "default" from a missing row.
  run(
    `INSERT INTO llm_master_prompt_history(version, content, saved_at, saved_by, reset)
     VALUES(?, ?, ?, ?, ?)`,
    nextVersion,
    isReset ? DEFAULT_MASTER_PROMPT : trimmed,
    nowIso, savedBy, isReset ? 1 : 0,
  )
  // Trim history rows beyond HISTORY_MAX to keep the table bounded.
  run(
    `DELETE FROM llm_master_prompt_history
      WHERE id NOT IN (
        SELECT id FROM llm_master_prompt_history ORDER BY id DESC LIMIT ?
      )`,
    HISTORY_MAX,
  )
  return getMasterPromptStatus()
}

export function listMasterPromptHistory(limit = 20): PromptHistoryRow[] {
  ensureSchema()
  return all<PromptHistoryRow>(
    `SELECT id, version, content, saved_at, saved_by, reset
       FROM llm_master_prompt_history
      ORDER BY id DESC
      LIMIT ?`,
    Math.max(1, Math.min(50, limit)),
  )
}

export function getHistoryEntry(id: number): PromptHistoryRow | null {
  ensureSchema()
  return one<PromptHistoryRow>(
    `SELECT id, version, content, saved_at, saved_by, reset
       FROM llm_master_prompt_history WHERE id = ?`,
    id,
  ) ?? null
}
