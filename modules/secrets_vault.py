"""Fernet-encrypted storage for sensitive settings.

Threat model: an attacker who obtains a copy of `data/ssr.db` (stolen
backup, snapshot, compromised CI) should NOT immediately have all our
upstream API keys in cleartext. Encrypting at the column level adds a
separate key file that must also be stolen.

The encryption key lives at `data/.ssr_secret_fernet` with 0600 perms.
It is generated automatically on first use if not present. To ROTATE:
  1) rotate_secrets() — re-encrypts every sensitive value with a new key
  2) Restart the dashboard so cached key is picked up

Which settings are encrypted is defined by the `SECRET_KEYS` list — any
setting whose key matches one of those prefixes/names gets Fernet-wrapped
at set_setting() time and auto-decrypted at get_setting() time.

Non-secret settings (numbers, flags, domains, channel enable bits) stay
plaintext — easier to inspect/debug and not security-sensitive.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken


_KEY_PATH = Path(__file__).parent.parent / "data" / ".ssr_secret_fernet"

# Exact keys to encrypt.
SECRET_KEYS_EXACT = {
    "spaceship_api_key", "spaceship_api_secret",
    "do_api_token", "do_api_token_backup",
    "serveravatar_api_key", "sa_dashboard_password",
    "smtp_password",
    "telegram_bot_token",
    "whatsapp_apikey", "greenapi_api_token",
    "twilio_auth_token",
    "dashboard_password",  # legacy plaintext only — dashboard_password_hash is PBKDF2 so it's NOT encrypted (would double-layer for nothing)
    "server_root_password",
}
# Prefixes where ANY key starting with `<prefix>_` is encrypted.
# llm_api_key_anthropic / llm_api_key_openai / etc. match this.
SECRET_KEYS_PREFIX = (
    "llm_api_key_",
)

# Marker prefix so we can distinguish encrypted bytes from legacy plaintext
# values that pre-date this module. Encrypted values start with "enc:v1:".
_MARKER = "enc:v1:"


def _load_key() -> bytes:
    """Load or generate the Fernet key. Key file is 0600-only."""
    _KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    if _KEY_PATH.exists():
        return _KEY_PATH.read_bytes().strip()
    key = Fernet.generate_key()
    _KEY_PATH.write_bytes(key)
    try:
        os.chmod(_KEY_PATH, 0o600)
    except Exception:
        pass  # Windows doesn't enforce the same way; best-effort
    return key


_cipher: Fernet | None = None


def _fernet() -> Fernet:
    global _cipher
    if _cipher is None:
        _cipher = Fernet(_load_key())
    return _cipher


def is_sensitive(key: str) -> bool:
    if key in SECRET_KEYS_EXACT:
        return True
    return any(key.startswith(p) for p in SECRET_KEYS_PREFIX)


def encrypt(value: str) -> str:
    """Encrypt a string. Empty strings are kept empty (so blank fields in
    the UI behave the same way as before)."""
    if not value:
        return value
    token = _fernet().encrypt(value.encode("utf-8")).decode("ascii")
    return _MARKER + token


def decrypt(value: str) -> str:
    """Decrypt a stored value. Returns the original string if the value
    isn't tagged as encrypted (so legacy plaintext rows still work until
    they're written again)."""
    if not value:
        return value
    if not value.startswith(_MARKER):
        return value  # legacy plaintext — handled transparently
    try:
        return _fernet().decrypt(value[len(_MARKER):].encode("ascii")).decode("utf-8")
    except InvalidToken:
        # Key changed or row corrupt. Return empty to force the user to
        # re-enter rather than crash at every get_setting() call.
        return ""


def rotate_secrets(db_path: str) -> dict:
    """Re-encrypt every SECRET_KEYS value with a freshly generated key.
    Blocking; call from a maintenance endpoint or CLI.

    Returns {"rotated": int, "skipped": int}.
    """
    # Save a reference to the OLD cipher before overwriting so we can
    # decrypt existing values, then re-encrypt with the new key.
    _ = SECRET_KEYS_EXACT  # keep import graph happy for mypy readers
    old = _fernet()
    # Freshen the key file + cached cipher
    new_key = Fernet.generate_key()
    _KEY_PATH.write_bytes(new_key)
    try:
        os.chmod(_KEY_PATH, 0o600)
    except Exception:
        pass
    global _cipher
    _cipher = Fernet(new_key)

    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    rotated = 0
    skipped = 0
    try:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        for r in rows:
            if not is_sensitive(r["key"]):
                continue
            v = r["value"] or ""
            if not v:
                continue
            if v.startswith(_MARKER):
                try:
                    plain = old.decrypt(
                        v[len(_MARKER):].encode("ascii")).decode("utf-8")
                except InvalidToken:
                    skipped += 1
                    continue
            else:
                plain = v  # legacy plaintext — wrap it now
            new_v = _MARKER + _cipher.encrypt(plain.encode("utf-8")).decode("ascii")
            conn.execute("UPDATE settings SET value=? WHERE key=?",
                         (new_v, r["key"]))
            rotated += 1
        conn.commit()
    finally:
        conn.close()
    return {"rotated": rotated, "skipped": skipped}
