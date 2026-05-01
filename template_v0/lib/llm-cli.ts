/**
 * Shell-out path for LLM providers whose vendor CLI does an OAuth login of
 * its own. Two providers wired today:
 *   - openai → `codex` CLI (tied to a ChatGPT Plus sub)
 *   - anthropic_cli → `claude` CLI (Claude Code, tied to Pro/Max sub)
 *
 * Gemini was removed — gemini-cli ≥ 0.38 hard-rejects non-interactive OAuth
 * and the dashboard-handled OAuth fallback was fragile across CLI version
 * bumps. Operators use the API-key path for Gemini instead (paste an AI
 * Studio key in Settings → llm_api_key_gemini).
 *
 * Why CLI shell-out: piggybacks on the auth the user already configured
 * with the CLI on disk — no API key in Settings, no separate API billing.
 * Paid for under the user's existing ChatGPT Plus / Claude Pro / Claude Max
 * subscription.
 *
 * This module also drives the dashboard's install/login flow:
 *   - findBinary()   — `where`/`which` lookup so the UI can show "Install" vs "Sign in"
 *   - isLoggedIn()   — checks the credentials file the CLI writes after OAuth
 *   - installCli()   — npm-installs the missing CLI globally (blocking)
 *   - startLogin()   — detached spawn of the CLI's OAuth flow; UI polls for
 *                      the credentials file to appear, then flips state.
 *   - signOut()      — deletes the credentials file so the next call re-auths.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type CliProvider = "openai" | "anthropic_cli"

interface CliMeta {
  /** Binary name the CLI ships as. */
  bin: string
  /** npm package name we install globally to provide that binary. */
  pkg: string
  /** Absolute path of the credentials file the CLI writes post-login. */
  credsPath: string
  /** Human-readable label for buttons / status text. */
  loginLabel: string
}

const META: Record<CliProvider, CliMeta> = {
  openai: {
    bin: "codex",
    pkg: "@openai/codex",
    credsPath: path.join(homedir(), ".codex", "auth.json"),
    loginLabel: "Sign in with ChatGPT",
  },
  anthropic_cli: {
    bin: "claude",
    pkg: "@anthropic-ai/claude-code",
    // Claude Code stores OAuth tokens at ~/.claude/.credentials.json (note
    // the leading dot on the file). Some platform builds also use macOS
    // Keychain — for those isLoggedIn() returns false even when logged-in;
    // the operator can set CLAUDE_CODE_OAUTH_TOKEN as a fallback (see
    // /settings → LLM → Claude Code CLI panel for the workflow).
    credsPath: path.join(homedir(), ".claude", ".credentials.json"),
    loginLabel: "Sign in with Claude",
  },
}

export function getCliMeta(provider: CliProvider): CliMeta {
  return META[provider]
}

interface CliInvocation {
  bin: string
  args: string[]
}

/**
 * Allowed shape for model identifiers. Mirrors the conservative subset of
 * provider model names we've actually seen ship: lowercase letters, digits,
 * dot, dash, underscore, slash, at, colon. Anything else (spaces, shell
 * metacharacters, control chars) is rejected at the caller — operator-supplied
 * `customModel` flows from /api/ai-generator/queue and /api/domains/.../run-*
 * routes through to spawn(), and we never want shell metacharacters in there
 * even if the platform's spawn implementation parses them safely.
 */
export const SAFE_MODEL_REGEX = /^[A-Za-z0-9._/@:-]{1,128}$/

export function assertSafeModel(model: string): void {
  if (!SAFE_MODEL_REGEX.test(model)) {
    throw new Error(`Invalid model name (allowed: A-Z a-z 0-9 . _ / @ : - and ≤128 chars): ${JSON.stringify(model.slice(0, 60))}`)
  }
}

/**
 * Build the argv (without the prompt). The prompt is ALWAYS piped via stdin
 * to bypass Windows cmd.exe arg-splitting — when `shell: true` is set on
 * Windows (required to resolve .cmd shims for global npm packages), an
 * unquoted multi-word prompt gets split at spaces and codex/gemini see each
 * word as a separate argv (`error: unexpected argument 'are' found`).
 *
 * codex: `-` as the positional means "read prompt from stdin".
 * gemini: `-p` is REQUIRED to enable non-interactive mode AND its value is
 *   appended to stdin content. We pass a single space as a marker so the
 *   flag is recognized, then write the real prompt via stdin (final prompt
 *   to the model = our prompt + " ").
 */
function buildInvocation(provider: CliProvider, model: string): CliInvocation {
  // Defense in depth — caller (runLlmCli) also validates, but if a future
  // direct caller forgets, this still catches it.
  assertSafeModel(model)
  if (provider === "anthropic_cli") {
    // Claude Code's `--print` mode outputs the response and exits.
    // Prompt comes via stdin (same reason as codex — bypasses Windows
    // cmd.exe arg-splitting on .cmd shims).
    return {
      bin: "claude",
      args: ["--print", "--model", model],
    }
  }
  return {
    bin: "codex",
    args: ["exec", "--skip-git-repo-check", "--model", model, "-"],
  }
}

export interface CliResult {
  text: string
  exitCode: number
}

/**
 * Run the provider's CLI with the combined prompt. Resolves with stdout on
 * exit 0; rejects with a message containing exit code + stderr on failure.
 */
export async function runLlmCli(
  provider: CliProvider,
  model: string,
  systemMsg: string,
  userMsg: string,
  // 5 min default — codex / gemini reasoning passes routinely take 60-120s
  // before emitting tokens. Caller can pass shorter for smoke-tests.
  timeoutMs = 5 * 60_000,
): Promise<CliResult> {
  // Validate model BEFORE building argv. operator-supplied customModel flows
  // from POST /api/ai-generator/queue (and similar) all the way to here.
  assertSafeModel(model)
  const fullPrompt = systemMsg ? `${systemMsg}\n\n---\n\n${userMsg}` : userMsg
  const { bin, args } = buildInvocation(provider, model)

  // Resolve the absolute binary path (e.g. C:\...\codex.cmd on Windows) so
  // we never need `shell: true` — the previous shell-mode spawn was the
  // only thing that made Windows handle .cmd shims, but it also meant any
  // future bug in the argv chain could become RCE through cmd.exe parsing.
  // With an explicit .cmd path, Node's spawn handles the shim natively.
  const resolvedBin = findBinary(provider) ?? bin

  // Per-provider env injection. anthropic_cli reads
  // CLAUDE_CODE_OAUTH_TOKEN from the settings vault and passes it through
  // so the `claude` binary auths without needing ~/.claude/.credentials.json
  // — the headless-server path. Empty means "fall back to whatever the
  // binary finds on disk", which is correct for desktops where
  // `claude setup-token` already wrote the creds file.
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  if (provider === "anthropic_cli") {
    try {
      const { getSetting } = require("./repos/settings") as typeof import("./repos/settings")
      const tok = (getSetting("claude_code_oauth_token") || "").trim()
      if (tok) childEnv.CLAUDE_CODE_OAUTH_TOKEN = tok
    } catch { /* settings unreachable — fall back to binary's own creds */ }
  }

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(resolvedBin, args, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
      })
    } catch (e) {
      reject(new Error(`${provider} CLI '${bin}' failed to start: ${(e as Error).message}`))
      return
    }

    // Wire data + close + error listeners FIRST so a fast-failing child has
    // its output captured. Earlier ordering (write → wire) lost the first
    // chunk on race + leaked the child if stdin.write threw before listeners
    // were attached.
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (b) => { stdout += b.toString() })
    child.stderr.on("data", (b) => { stderr += b.toString() })

    // Pipe the full prompt via stdin so cmd.exe never touches it. codex's
    // `-` positional and gemini's stdin-append behavior consume this. If
    // the write fails, kill the child first so it doesn't linger as a
    // zombie writing to its own pipes.
    try {
      child.stdin?.write(fullPrompt)
      child.stdin?.end()
    } catch (e) {
      try { child.kill() } catch { /* already dead */ }
      reject(new Error(`${bin}: failed to write prompt to stdin: ${(e as Error).message}`))
      return
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already dead */ }
      reject(new Error(`${provider} CLI timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)

    child.on("error", (e) => {
      clearTimeout(timer)
      // ENOENT here is the "binary not on PATH" path — surface it in plain
      // English so the operator knows what to install.
      const code = (e as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        reject(new Error(`${bin} not found on PATH — install the ${provider} CLI and run its login first`))
      } else {
        reject(new Error(`${bin}: ${e.message}`))
      }
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      // Classify known failure patterns ONLY when the call actually failed
      // (non-zero exit OR empty stdout on exit 0 — codex hits its quota
      // limit and exits 0 sometimes, with the error message embedded in
      // stdout instead of a real result).
      // Don't classify on successful exit-0 with non-empty stdout: the
      // classifier regex would false-positive on legitimate model output
      // that happened to mention "usage limit" or "log in" in the page copy
      // (e.g. a generated marketing page for a SaaS product).
      const combined = `${stderr}\n${stdout}`
      const lookedLikeFailure = code !== 0 || stdout.trim().length === 0
      if (lookedLikeFailure) {
        const classified = classifyCliFailure(provider, combined)
        if (classified) {
          reject(new Error(classified))
          return
        }
      }
      if (code !== 0) {
        const detail = (stderr || stdout).trim().slice(0, 400) || "(no stderr)"
        reject(new Error(`${bin} exit ${code}: ${detail}`))
        return
      }
      resolve({ text: stdout, exitCode: code ?? 0 })
    })
  })
}

/**
 * Pattern-match known LLM-CLI failure modes out of stdout+stderr. Returns
 * a concise actionable message, or null if nothing matched (caller falls
 * through to generic exit-code reporting).
 *
 * Each entry should be a real failure I or someone has actually seen — keep
 * the list short so it's easy to verify a match isn't false-positive on
 * normal output. Rule of thumb: anchor on multi-word phrases the CLI
 * embeds verbatim.
 */
function classifyCliFailure(provider: CliProvider, combined: string): string | null {
  // Quota / usage-limit detection — pattern is similar across both CLIs;
  // the error string varies but the root cause (operator hit their plan
  // cap) is the same. Pull out the reset date if present.
  if (/hit your usage limit|usage limit reached|quota.*exceeded|message limit/i.test(combined)) {
    const m = combined.match(/try again at ([^.\n]+)|reset(?:s|ed at)? ([^.\n]+)/i)
    const resetNote = m ? ` — quota resets ${(m[1] ?? m[2] ?? "").trim()}` : ""
    const cliName = provider === "anthropic_cli" ? "Claude Code" : "OpenAI Codex"
    return `${cliName} usage limit hit${resetNote}. ` +
      `Switch provider in the Regenerate dialog (Cloudflare Workers AI POOL is free and stacked) ` +
      `or change the default in /settings → LLM.`
  }
  if (provider === "openai" &&
      /please.*log.in|run.*codex.*login|not.*authenticated|unauthenticated/i.test(combined)) {
    return `Codex CLI not signed in. Click "Sign in with ChatGPT" in /settings → LLM, then retry.`
  }
  if (provider === "anthropic_cli" &&
      /please.*log.in|claude.*login|not.*authenticated|unauthenticated|invalid.*api.*key|invalid.*token/i.test(combined)) {
    return `Claude Code CLI not signed in. Click "Sign in with Claude" in /settings → LLM, ` +
      `or set CLAUDE_CODE_OAUTH_TOKEN env var on the server, then retry.`
  }
  return null
}

/**
 * Cheap auth probe — runs a one-token "say hi" through the CLI to confirm
 * the binary exists, the user is logged in, and a request round-trips.
 * Returns a concise human-readable status used by the Test button in the
 * settings UI.
 */
export async function probeLlmCli(
  provider: CliProvider,
  model: string,
): Promise<{ ok: boolean; info?: string; error?: string }> {
  try {
    const { text } = await runLlmCli(
      provider,
      model,
      "",
      "Reply with the single word: ok",
      45_000,
    )
    const trimmed = text.trim().slice(0, 200)
    return { ok: true, info: trimmed || "(empty response)" }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Install / login / sign-out helpers driven by the dashboard
// ---------------------------------------------------------------------------

const LOGIN_TIMEOUT_MS = 5 * 60_000

interface LoginAttempt {
  startedAt: number
  child: ChildProcess
  /** Tail of stdout/stderr captured for surfacing failures back to the UI. */
  log: string
  /** Set when the child exits BEFORE the credentials file appeared. */
  failure?: string
}

/** Module-level: at most one in-flight login attempt per provider. */
const loginAttempts = new Map<CliProvider, LoginAttempt>()

/** `where` (Windows) / `which` (POSIX) — returns absolute path or null. */
export function findBinary(provider: CliProvider): string | null {
  const { bin } = META[provider]
  const lookup = process.platform === "win32" ? "where" : "which"
  const r = spawnSync(lookup, [bin], { encoding: "utf8", windowsHide: true })
  if (r.status !== 0) return null
  const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
  return first || null
}

export function isInstalled(provider: CliProvider): boolean {
  return findBinary(provider) !== null
}

export function isLoggedIn(provider: CliProvider): boolean {
  if (existsSync(META[provider].credsPath)) return true
  // anthropic_cli also accepts a long-lived OAuth token pasted into
  // /settings → LLM → Claude Code CLI. Without this fallback the panel
  // would show "Signed in: no" on a headless server even though calls
  // would actually work via the env-var.
  if (provider === "anthropic_cli") {
    try {
      const { getSetting } = require("./repos/settings") as typeof import("./repos/settings")
      const tok = (getSetting("claude_code_oauth_token") || "").trim()
      if (tok) return true
    } catch { /* settings unavailable on first boot */ }
  }
  return false
}

/**
 * Best-effort identifier for the signed-in account, surfaced as a chip in
 * the UI. The CLIs don't standardise the field name; we read what we can
 * and fall back to `(signed in)` so the panel always has *something* to
 * render once the credentials file is present.
 */
export function inferAccount(provider: CliProvider): string | null {
  const { credsPath } = META[provider]
  if (!existsSync(credsPath)) {
    // Token-only path — no creds file to parse, just say which fallback
    // is active so the panel doesn't render an empty "Signed in" chip.
    if (provider === "anthropic_cli") {
      try {
        const { getSetting } = require("./repos/settings") as typeof import("./repos/settings")
        if ((getSetting("claude_code_oauth_token") || "").trim()) {
          return "(via OAuth token)"
        }
      } catch { /* ignore */ }
    }
    return null
  }
  try {
    const raw = readFileSync(credsPath, "utf8")
    const json = JSON.parse(raw) as Record<string, unknown>
    // Common shapes seen across versions: { email }, { account: { email } },
    // { tokens: { account: { email } } }. Walk a few likely paths.
    const candidates = [
      json.email,
      (json.account as Record<string, unknown> | undefined)?.email,
      (json.tokens as Record<string, unknown> | undefined)?.email,
      ((json.tokens as Record<string, unknown> | undefined)?.account as Record<string, unknown> | undefined)?.email,
      json.user_id,
      json.username,
    ]
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim()
    }
  } catch {
    /* fall through */
  }
  return "(signed in)"
}

export interface CliStatus {
  provider: CliProvider
  bin: string
  installed: boolean
  binaryPath: string | null
  loggedIn: boolean
  credsPath: string
  account: string | null
  loginInProgress: boolean
  loginStartedAt: number | null
  loginFailure: string | null
}

export function getCliStatus(provider: CliProvider): CliStatus {
  const meta = META[provider]
  const binaryPath = findBinary(provider)
  const loggedIn = isLoggedIn(provider)

  const attempt = loginAttempts.get(provider)
  // Evict the attempt slot once the creds appeared OR the child exited.
  if (attempt && (loggedIn || attempt.child.exitCode !== null)) {
    loginAttempts.delete(provider)
  }
  return {
    provider,
    bin: meta.bin,
    installed: binaryPath !== null,
    binaryPath,
    loggedIn,
    credsPath: meta.credsPath,
    account: loggedIn ? inferAccount(provider) : null,
    loginInProgress: !loggedIn && loginAttempts.has(provider),
    loginStartedAt: loginAttempts.get(provider)?.startedAt ?? null,
    loginFailure: attempt?.failure ?? null,
  }
}

/**
 * Blocking npm-install of the global CLI package. Used by the dashboard
 * "Install" button. Returns a concise outcome the UI can render.
 */
export async function installCli(provider: CliProvider): Promise<{
  ok: boolean
  output: string
  error?: string
}> {
  const { pkg, bin } = META[provider]
  return new Promise((resolve) => {
    let out = ""
    const child = spawn("npm", ["install", "-g", pkg], {
      shell: process.platform === "win32",
      windowsHide: true,
    })
    child.stdout.on("data", (b) => { out += b.toString() })
    child.stderr.on("data", (b) => { out += b.toString() })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* */ }
      resolve({ ok: false, output: out.slice(-2000), error: `npm install timed out (5 min)` })
    }, 5 * 60_000)
    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ ok: false, output: out.slice(-2000), error: e.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0 && findBinary(provider)) {
        resolve({ ok: true, output: out.slice(-2000) })
      } else {
        resolve({
          ok: false, output: out.slice(-2000),
          error: `npm exit ${code} — ${bin} still not on PATH`,
        })
      }
    })
  })
}

/**
 * Kick off the OAuth sign-in flow. Spawns `codex login` as a detached child.
 * The codex CLI handles its own OAuth (opens browser, binds local port,
 * writes auth.json). We monitor the child for exit so we can surface
 * failures. Returns immediately — the UI polls /api/llm-cli/status to
 * detect the credentials file appearing (success) or `loginFailure`
 * populating (failure).
 *
 * (Gemini's CLI sign-in was removed because gemini-cli ≥ 0.38 hard-rejects
 * non-interactive OAuth; operators use the API-key path instead.)
 */
export function startLogin(provider: CliProvider): { ok: boolean; error?: string } {
  // openai → spawn codex login
  if (!isInstalled(provider)) {
    return { ok: false, error: `${META[provider].bin} not installed — click Install first` }
  }
  if (isLoggedIn(provider)) {
    return { ok: false, error: `Already signed in to ${META[provider].bin}` }
  }
  const existing = loginAttempts.get(provider)
  if (existing && existing.child.exitCode === null) {
    return { ok: false, error: "Login already in progress — finish it in the browser or click Cancel" }
  }

  const bin = META[provider].bin
  // codex: `codex login`; claude: `claude /login` is REPL-only, the headless
  // CLI flag is `claude setup-token` (writes ~/.claude/.credentials.json
  // directly after browser OAuth — same shape as codex login).
  const args = provider === "anthropic_cli" ? ["setup-token"] : ["login"]

  let child: ChildProcess
  try {
    child = spawn(bin, args, {
      shell: process.platform === "win32",
      windowsHide: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (e) {
    return { ok: false, error: `failed to spawn ${bin}: ${(e as Error).message}` }
  }

  const attempt: LoginAttempt = { startedAt: Date.now(), child, log: "" }
  loginAttempts.set(provider, attempt)

  const append = (b: Buffer) => {
    attempt.log = (attempt.log + b.toString()).slice(-4000)
  }
  child.stdout?.on("data", append)
  child.stderr?.on("data", append)

  child.on("close", (code) => {
    if (!isLoggedIn(provider) && code !== 0) {
      // Operator precedence note: `a + b || c` is `(a + b) || c`, so the
      // "(no output)" fallback never fired (the prefix made the whole
      // string truthy). Compute the tail FIRST, then concatenate.
      const tail = attempt.log.trim().slice(-400) || "(no output captured — likely TTY-only error)"
      attempt.failure = `${bin} exited ${code} before sign-in completed: ${tail}`
    }
  })

  // Auto-cleanup if the user walks away without completing the OAuth flow.
  setTimeout(() => {
    const cur = loginAttempts.get(provider)
    if (cur === attempt && !isLoggedIn(provider)) {
      try { cur.child.kill() } catch { /* already dead */ }
      cur.failure = "Login timed out (5 min) — click Sign in to try again"
    }
  }, LOGIN_TIMEOUT_MS).unref()

  return { ok: true }
}

/** Cancel an in-progress login (kill the codex login child process). */
export function cancelLogin(provider: CliProvider): { ok: boolean } {
  const attempt = loginAttempts.get(provider)
  if (attempt) {
    try { attempt.child.kill() } catch { /* */ }
    loginAttempts.delete(provider)
  }
  return { ok: true }
}

/** Delete the credentials file so the next call re-prompts for login. */
export function signOut(provider: CliProvider): { ok: boolean; error?: string } {
  const { credsPath } = META[provider]
  if (!existsSync(credsPath)) return { ok: true }
  try {
    rmSync(credsPath, { force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
