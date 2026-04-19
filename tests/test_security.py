"""Tests for security-critical behaviours: password hashing (H1/H2),
secret encryption at rest (#2), domain validation."""
from werkzeug.security import check_password_hash, generate_password_hash
from modules.secrets_vault import is_sensitive, encrypt, decrypt, _MARKER


def test_password_hash_round_trip():
    h = generate_password_hash("ABC!@#", method="pbkdf2:sha256", salt_length=16)
    assert h.startswith("pbkdf2:sha256:")
    assert check_password_hash(h, "ABC!@#") is True
    assert check_password_hash(h, "wrong") is False


def test_fernet_encrypts_and_decrypts():
    plain = "do_v1_SECRETTOKEN12345"
    enc = encrypt(plain)
    assert enc.startswith(_MARKER)
    assert plain not in enc  # no leakage
    assert decrypt(enc) == plain


def test_decrypt_passes_legacy_plaintext_through():
    """Unwrapped (no marker) → return as-is; keeps legacy DB rows working."""
    assert decrypt("plaintext-legacy") == "plaintext-legacy"
    assert decrypt("") == ""


def test_is_sensitive_matching():
    # Exact keys
    assert is_sensitive("do_api_token") is True
    assert is_sensitive("telegram_bot_token") is True
    assert is_sensitive("dashboard_password") is True
    # Prefix keys
    assert is_sensitive("llm_api_key_anthropic") is True
    assert is_sensitive("llm_api_key_openai") is True
    # Non-secret
    assert is_sensitive("dashboard_password_hash") is False
    assert is_sensitive("live_check_interval_s") is False
    assert is_sensitive("notify_email") is False
    assert is_sensitive("whatsapp_phone") is False


def test_domain_validation_regex(tmp_db):
    """Domain validation on /api/domains POST — regex must reject shell-
    metachar and path-traversal attempts."""
    from app import _validate_domain
    good = ["example.com", "sub.example.co.uk", "a1b2c3.xyz"]
    for d in good:
        assert _validate_domain(d) == d.lower()
    bad = ["../passwd", "foo/bar.com", ".bad", "bad.", "a", "", "a" * 300,
           "foo..bar.com", "foo.bar..com"]
    for d in bad:
        assert _validate_domain(d) is None, f"expected reject: {d!r}"
