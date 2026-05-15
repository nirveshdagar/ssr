import { one, run } from "../db"
import { isSensitive, encrypt, decrypt } from "../secrets-vault"

export function getSetting(key: string): string | null {
  const row = one<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)
  const v = row?.value ?? null
  if (v && isSensitive(key)) return decrypt(v)
  return v
}

export function setSetting(key: string, value: string): void {
  let toStore = value
  if (value && isSensitive(key)) {
    try {
      toStore = encrypt(value)
    } catch {
      // best-effort — don't break settings save if Fernet breaks
    }
  }
  run(
    `INSERT INTO settings(key, value, updated_at) VALUES(?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    key,
    toStore,
  )
}
