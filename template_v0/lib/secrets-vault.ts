/**
 * Fernet-encrypted column storage for sensitive settings — Node port of
 * modules/secrets_vault.py.
 *
 * Parallel-Flask parity: the same `data/.ssr_secret_fernet` key file works
 * for BOTH apps. Encrypted values written here are read transparently by
 * the Flask side and vice versa. We re-implement Fernet on top of node:crypto
 * (no third-party dep) so the byte format matches the Python `cryptography`
 * package exactly.
 *
 * Encrypted values are tagged with the marker `enc:v1:` so legacy plaintext
 * rows (pre-vault) keep working — decrypt() is a no-op for unmarked strings.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs"
import path from "node:path"
import { all, run } from "./db"

// ---------------------------------------------------------------------------
// Sensitive-key registry — must mirror modules/secrets_vault.py
// ---------------------------------------------------------------------------

export const SECRET_KEYS_EXACT = new Set<string>([
  "spaceship_api_key", "spaceship_api_secret",
  "do_api_token", "do_api_token_backup",
  "serveravatar_api_key", "serveravatar_api_key_backup",
  "sa_dashboard_password",
  "smtp_password",
  "telegram_bot_token",
  "whatsapp_apikey", "greenapi_api_token",
  "twilio_auth_token",
  "dashboard_password",
  "server_root_password",
  "cloudflare_workers_ai_token",
  // Claude Code CLI long-lived OAuth token. When set, runLlmCli passes it
  // to the `claude` binary via CLAUDE_CODE_OAUTH_TOKEN env, bypassing the
  // ~/.claude/.credentials.json flow. Useful on headless servers where
  // the browser-based `claude setup-token` round-trip isn't practical.
  "claude_code_oauth_token",
])

export const SECRET_KEYS_PREFIX = ["llm_api_key_"] as const

const MARKER = "enc:v1:"

export function isSensitive(key: string): boolean {
  if (SECRET_KEYS_EXACT.has(key)) return true
  return SECRET_KEYS_PREFIX.some((p) => key.startsWith(p))
}

// ---------------------------------------------------------------------------
// Key file resolution — same logic as db.ts so Flask + Node share the file
// ---------------------------------------------------------------------------

function resolveKeyPath(): string {
  if (process.env.SSR_FERNET_KEY_PATH) return process.env.SSR_FERNET_KEY_PATH
  const dbPath = process.env.SSR_DB_PATH
  if (dbPath) {
    return path.join(path.dirname(dbPath), ".ssr_secret_fernet")
  }
  return path.resolve(process.cwd(), "..", "data", ".ssr_secret_fernet")
}

// ---------------------------------------------------------------------------
// urlsafe-base64 — Python's base64.urlsafe_b64encode/decode equivalent
// (same as RFC 4648 §5; node Buffer's "base64url" matches but rejects '=' so
// we normalize before/after)
// ---------------------------------------------------------------------------

function urlsafeB64Encode(buf: Buffer): string {
  // Python's Fernet uses urlsafe_b64encode which INCLUDES '=' padding.
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_")
}

function urlsafeB64Decode(s: string): Buffer {
  // Accept both padded and unpadded variants (Python writes padded; spec is
  // padded). Re-pad to a multiple of 4 if needed.
  const norm = s.replace(/-/g, "+").replace(/_/g, "/")
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4)
  return Buffer.from(padded, "base64")
}

// ---------------------------------------------------------------------------
// Key load / generate
// ---------------------------------------------------------------------------

interface FernetKeys {
  signing: Buffer    // 16 bytes — HMAC-SHA256
  encryption: Buffer // 16 bytes — AES-128-CBC
  raw: Buffer        // 32 bytes
  encoded: string    // urlsafe-base64 of raw (44 chars)
}

let cachedKeys: FernetKeys | null = null

function generateKey(): { raw: Buffer; encoded: string } {
  const raw = randomBytes(32)
  return { raw, encoded: urlsafeB64Encode(raw) }
}

function loadKeys(): FernetKeys {
  if (cachedKeys) return cachedKeys
  const keyPath = resolveKeyPath()
  let encoded: string
  if (existsSync(keyPath)) {
    encoded = readFileSync(keyPath, "utf8").trim()
  } else {
    // Production guard: if there are already encrypted rows in `settings`
    // and the key file is missing, refuse to auto-generate. A fresh key
    // would silently invalidate every existing ciphertext (decrypt() returns
    // "" on HMAC mismatch), turning a recoverable "key file lost" situation
    // into "every secret is gone, nothing tells you that". Operator must
    // restore the key from backup or delete the encrypted rows explicitly.
    if (process.env.NODE_ENV === "production" && encryptedRowsExist()) {
      throw new Error(
        `Fernet key file missing at ${keyPath} but encrypted rows exist in settings. ` +
        `Refusing to auto-generate a new key (would invalidate every encrypted secret). ` +
        `Restore from backup or delete the enc:v1: rows first.`,
      )
    }
    mkdirSync(path.dirname(keyPath), { recursive: true })
    const fresh = generateKey()
    encoded = fresh.encoded
    writeFileSync(keyPath, encoded, { encoding: "utf8" })
    try { chmodSync(keyPath, 0o600) } catch { /* Windows best-effort */ }
  }
  const raw = urlsafeB64Decode(encoded)
  if (raw.length !== 32) {
    throw new Error(`Fernet key must decode to 32 bytes, got ${raw.length}. File: ${keyPath}`)
  }
  cachedKeys = {
    signing: raw.subarray(0, 16),
    encryption: raw.subarray(16, 32),
    raw,
    encoded,
  }
  return cachedKeys
}

export function hasAnyEncryptedRows(): boolean {
  return encryptedRowsExist()
}

function encryptedRowsExist(): boolean {
  try {
    const rows = all<{ value: string }>(
      "SELECT value FROM settings WHERE value LIKE 'enc:v1:%' LIMIT 1",
    )
    if (rows.length > 0) return true
    // Also check the secondary tables we encrypt at rest.
    const aiRows = all<{ api_token: string }>(
      "SELECT api_token FROM cf_workers_ai_keys WHERE api_token LIKE 'enc:v1:%' LIMIT 1",
    )
    if (aiRows.length > 0) return true
    const cfRows = all<{ api_key: string }>(
      "SELECT api_key FROM cf_keys WHERE api_key LIKE 'enc:v1:%' LIMIT 1",
    )
    return cfRows.length > 0
  } catch { return false }
}

function setKeysFromEncoded(encoded: string): FernetKeys {
  const raw = urlsafeB64Decode(encoded)
  if (raw.length !== 32) throw new Error(`Fernet key must decode to 32 bytes, got ${raw.length}`)
  cachedKeys = {
    signing: raw.subarray(0, 16),
    encryption: raw.subarray(16, 32),
    raw,
    encoded,
  }
  return cachedKeys
}

// ---------------------------------------------------------------------------
// Fernet primitives — token format:
//   version (1) || timestamp (8 BE) || IV (16) || ciphertext || HMAC (32)
// All concatenated, then urlsafe-base64 encoded.
// ---------------------------------------------------------------------------

const VERSION = 0x80

function fernetEncryptRaw(plaintext: Buffer, keys: FernetKeys, iv?: Buffer): string {
  const ts = Buffer.alloc(8)
  const seconds = BigInt(Math.floor(Date.now() / 1000))
  ts.writeBigUInt64BE(seconds, 0)
  const ivBytes = iv ?? randomBytes(16)
  const cipher = createCipheriv("aes-128-cbc", keys.encryption, ivBytes)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const versionByte = Buffer.from([VERSION])
  const hmacInput = Buffer.concat([versionByte, ts, ivBytes, ciphertext])
  const tag = createHmac("sha256", keys.signing).update(hmacInput).digest()
  return urlsafeB64Encode(Buffer.concat([hmacInput, tag]))
}

function fernetDecryptRaw(token: string, keys: FernetKeys): Buffer {
  const data = urlsafeB64Decode(token)
  if (data.length < 1 + 8 + 16 + 32) throw new Error("Fernet token too short")
  if (data[0] !== VERSION) throw new Error(`Fernet version mismatch: ${data[0]}`)
  const tag = data.subarray(data.length - 32)
  const hmacInput = data.subarray(0, data.length - 32)
  const expected = createHmac("sha256", keys.signing).update(hmacInput).digest()
  if (!constantTimeEqual(tag, expected)) throw new Error("Fernet HMAC mismatch")
  const iv = hmacInput.subarray(9, 25)
  const ciphertext = hmacInput.subarray(25)
  const decipher = createDecipheriv("aes-128-cbc", keys.encryption, iv)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// ---------------------------------------------------------------------------
// Public surface — encrypt / decrypt / rotate
// ---------------------------------------------------------------------------

export function encrypt(value: string): string {
  if (!value) return value
  const token = fernetEncryptRaw(Buffer.from(value, "utf8"), loadKeys())
  return MARKER + token
}

export function decrypt(value: string): string {
  if (!value) return value
  if (!value.startsWith(MARKER)) return value // legacy plaintext passthrough
  try {
    return fernetDecryptRaw(value.slice(MARKER.length), loadKeys()).toString("utf8")
  } catch {
    // Key changed or row corrupt — return empty to force re-entry rather
    // than crash on every getSetting() call.
    return ""
  }
}

/**
 * Re-encrypt every sensitive settings value with a fresh key. Blocking;
 * call from a maintenance endpoint or CLI. Mirrors the Python rotate_secrets.
 */
export function rotateSecrets(): { rotated: number; skipped: number } {
  const oldKeys = loadKeys()
  const fresh = generateKey()
  const keyPath = resolveKeyPath()
  writeFileSync(keyPath, fresh.encoded, { encoding: "utf8" })
  try { chmodSync(keyPath, 0o600) } catch { /* Windows best-effort */ }
  const newKeys = setKeysFromEncoded(fresh.encoded)

  const rows = all<{ key: string; value: string | null }>(
    "SELECT key, value FROM settings",
  )
  let rotated = 0
  let skipped = 0
  for (const r of rows) {
    if (!isSensitive(r.key)) continue
    const v = r.value || ""
    if (!v) continue
    let plain: string
    if (v.startsWith(MARKER)) {
      try {
        plain = fernetDecryptRaw(v.slice(MARKER.length), oldKeys).toString("utf8")
      } catch {
        skipped++
        continue
      }
    } else {
      plain = v
    }
    const newVal = MARKER + fernetEncryptRaw(Buffer.from(plain, "utf8"), newKeys)
    run(
      "UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?",
      newVal,
      r.key,
    )
    rotated++
  }
  return { rotated, skipped }
}

/** For tests — drop the cached key so a freshly-rotated keyfile is re-read. */
export function _resetCache(): void {
  cachedKeys = null
}
