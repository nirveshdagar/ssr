"""Tests for the SSL cert metadata extraction (modules/pipeline._extract_cert_metadata).

Generates a self-signed cert at test time so we don't depend on an external
certificate file or a network call.
"""
from datetime import datetime, timedelta, timezone

import pytest


@pytest.fixture
def self_signed_pem():
    """Return a (pem_str, expected_metadata_subset) tuple for a freshly-
    generated self-signed certificate."""
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "test.example.com"),
    ])
    not_before = datetime(2025, 1, 1, tzinfo=timezone.utc)
    not_after = not_before + timedelta(days=365)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(12345)
        .not_valid_before(not_before)
        .not_valid_after(not_after)
        .sign(key, hashes.SHA256())
    )
    pem = cert.public_bytes(serialization.Encoding.PEM).decode("ascii")
    return pem


def test_extract_returns_subject_cn(self_signed_pem):
    from modules.pipeline import _extract_cert_metadata
    meta = _extract_cert_metadata(self_signed_pem)
    assert meta["subject_cn"] == "test.example.com"
    assert meta["issuer_cn"] == "test.example.com"


def test_extract_returns_validity_window(self_signed_pem):
    from modules.pipeline import _extract_cert_metadata
    meta = _extract_cert_metadata(self_signed_pem)
    assert "2025-01-01" in meta["not_before"]
    # Roughly 365 days later
    assert "2026" in meta["not_after"]


def test_extract_returns_sha256_fingerprint(self_signed_pem):
    from modules.pipeline import _extract_cert_metadata
    meta = _extract_cert_metadata(self_signed_pem)
    assert len(meta["sha256"]) == 64  # 32 bytes hex-encoded
    assert all(c in "0123456789abcdef" for c in meta["sha256"])


def test_extract_returns_serial(self_signed_pem):
    from modules.pipeline import _extract_cert_metadata
    meta = _extract_cert_metadata(self_signed_pem)
    assert meta["serial_number"] == "12345"


def test_extract_returns_empty_dict_on_garbage_input():
    from modules.pipeline import _extract_cert_metadata
    assert _extract_cert_metadata("not a cert") == {}
    assert _extract_cert_metadata("") == {}


def test_extract_metadata_is_json_serializable(self_signed_pem):
    """artifact_json roundtrip — must serialize cleanly."""
    import json
    from modules.pipeline import _extract_cert_metadata
    meta = _extract_cert_metadata(self_signed_pem)
    out = json.dumps(meta)
    back = json.loads(out)
    assert back == meta
