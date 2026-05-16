// Standalone Spaceship availability probe — run ON THE DROPLET.
// Mirrors lib/spaceship.ts checkAvailability + lib/secrets-vault.ts decrypt
// exactly, using prod's real creds, with ZERO app rebuild.
//
//   node tmp_spaceship_probe.mjs <domain> [dbPath] [keyPath]
//
// Defaults to the prod layout (/opt/ssr/data/...).

import { readFileSync } from "node:fs"
import { createDecipheriv, createHmac } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

const domain = process.argv[2]
const DB_PATH = process.argv[3] || "/opt/ssr/data/ssr.db"
const KEY_PATH = process.argv[4] || "/opt/ssr/data/.ssr_secret_fernet"
const MARKER = "enc:v1:"
const VERSION = 0x80

if (!domain) {
  console.error("usage: node tmp_spaceship_probe.mjs <domain> [dbPath] [keyPath]")
  process.exit(2)
}

function urlsafeB64Decode(s) {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/")
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4)
  return Buffer.from(padded, "base64")
}

function loadKeys() {
  const raw = urlsafeB64Decode(readFileSync(KEY_PATH, "utf8").trim())
  if (raw.length !== 32) throw new Error(`key must decode to 32 bytes, got ${raw.length}`)
  return { signing: raw.subarray(0, 16), encryption: raw.subarray(16, 32) }
}

function fernetDecryptRaw(token, keys) {
  const data = urlsafeB64Decode(token)
  if (data.length < 1 + 8 + 16 + 32) throw new Error("token too short")
  if (data[0] !== VERSION) throw new Error(`version mismatch: ${data[0]}`)
  const tag = data.subarray(data.length - 32)
  const hmacInput = data.subarray(0, data.length - 32)
  const expected = createHmac("sha256", keys.signing).update(hmacInput).digest()
  if (Buffer.compare(tag, expected) !== 0) throw new Error("HMAC mismatch (wrong key file?)")
  const iv = hmacInput.subarray(9, 25)
  const ciphertext = hmacInput.subarray(25)
  const decipher = createDecipheriv("aes-128-cbc", keys.encryption, iv)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
}

function decryptMaybe(value, keys) {
  if (!value) return value
  if (!value.startsWith(MARKER)) return value // legacy plaintext passthrough
  return fernetDecryptRaw(value.slice(MARKER.length), keys)
}

const keys = loadKeys()
const db = new DatabaseSync(DB_PATH, { readOnly: true })
const get = (k) => db.prepare("SELECT value FROM settings WHERE key = ?").get(k)?.value ?? null

const apiKey = decryptMaybe(get("spaceship_api_key"), keys)
const apiSecret = decryptMaybe(get("spaceship_api_secret"), keys)
db.close()

console.log("=== creds ===")
console.log("api_key   :", apiKey ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)} (len ${apiKey.length})` : "MISSING")
console.log("api_secret:", apiSecret ? `set (len ${apiSecret.length})` : "MISSING")
if (!apiKey || !apiSecret) { console.error("\n>>> Spaceship creds not set in prod settings — that's the bug."); process.exit(1) }

const res = await fetch("https://spaceship.dev/api/v1/domains/available", {
  method: "POST",
  headers: { "X-API-Key": apiKey, "X-API-Secret": apiSecret, "Content-Type": "application/json" },
  body: JSON.stringify({ domains: [domain] }),
})
const text = await res.text()
console.log(`\n=== POST /domains/available  (domain: ${domain}) ===`)
console.log("HTTP", res.status, res.statusText)
console.log("RAW BODY:")
console.log(text)

try {
  const json = JSON.parse(text)
  const entries = json.domains ?? []
  const info = entries.find((e) => (e.name ?? "").toLowerCase() === domain.toLowerCase()) ?? entries[0]
  console.log("\n=== what step1BuyOrDetect would compute ===")
  console.log("avail.domains present?:", Array.isArray(json.domains))
  console.log("matched entry        :", JSON.stringify(info))
  console.log("isAvailable (Boolean):", Boolean(info?.isAvailable), "  <-- false here = the bug")
} catch {
  console.log("\n(body is not JSON — pipeline would also fail to parse this)")
}
