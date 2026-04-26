"""Tests for the preflight checks (modules/preflight.py).

Each check is exercised against an in-memory tmp_db; network-hitting checks
are exercised only via their failure paths (missing-credential cases) since
we can't make the actual upstream calls in CI. The good-path / network paths
of do_token / sa_auth / spaceship_auth are exercised by /api/preflight at
runtime, not unit tests."""
import pytest


# ---------------------------------------------------------------------------
# CF pool
# ---------------------------------------------------------------------------

def test_check_cf_pool_no_keys(tmp_db):
    from modules import preflight
    r = preflight.check_cf_pool()
    assert r["ok"] is False
    assert "No active CF keys" in r["message"]


def test_check_cf_pool_one_key_with_capacity(tmp_db):
    from database import get_db
    from modules import preflight
    conn = get_db()
    conn.execute(
        """INSERT INTO cf_keys
             (email, api_key, alias, is_active, domains_used, max_domains)
           VALUES ('a@b.c', 'KEY', 'CF1', 1, 0, 20)"""
    )
    conn.commit()
    conn.close()
    r = preflight.check_cf_pool()
    assert r["ok"] is True
    assert "1 key(s) with capacity" in r["message"]
    assert "20 domain slot(s) free" in r["message"]


def test_check_cf_pool_all_keys_full(tmp_db):
    from database import get_db
    from modules import preflight
    conn = get_db()
    conn.execute(
        """INSERT INTO cf_keys
             (email, api_key, alias, is_active, domains_used, max_domains)
           VALUES ('a@b.c', 'KEY', 'CF1', 1, 20, 20)"""
    )
    conn.commit()
    conn.close()
    r = preflight.check_cf_pool()
    assert r["ok"] is False
    assert "at capacity" in r["message"]


def test_check_cf_pool_inactive_keys_dont_count(tmp_db):
    from database import get_db
    from modules import preflight
    conn = get_db()
    conn.execute(
        """INSERT INTO cf_keys
             (email, api_key, alias, is_active, domains_used, max_domains)
           VALUES ('a@b.c', 'KEY', 'CF1', 0, 0, 20)"""
    )
    conn.commit()
    conn.close()
    r = preflight.check_cf_pool()
    assert r["ok"] is False
    assert "No active CF keys" in r["message"]


# ---------------------------------------------------------------------------
# DO token
# ---------------------------------------------------------------------------

def test_check_do_token_unset(tmp_db):
    from modules import preflight
    r = preflight.check_do_token()
    assert r["ok"] is False
    assert "DO_API_TOKEN not set" in r["message"]


# ---------------------------------------------------------------------------
# SA auth
# ---------------------------------------------------------------------------

def test_check_sa_auth_unset(tmp_db):
    from modules import preflight
    r = preflight.check_sa_auth()
    assert r["ok"] is False
    assert "not set" in r["message"]


def test_check_sa_auth_token_set_but_org_missing(tmp_db):
    from database import set_setting
    from modules import preflight
    set_setting("serveravatar_api_key", "Bearer xxx")
    r = preflight.check_sa_auth()
    assert r["ok"] is False
    assert "ORG_ID" in r["message"]


# ---------------------------------------------------------------------------
# Spaceship
# ---------------------------------------------------------------------------

def test_check_spaceship_skip_purchase_skips(tmp_db):
    from modules import preflight
    r = preflight.check_spaceship_auth(skip_purchase=True)
    assert r["ok"] is True
    assert "Skipped" in r["message"]


def test_check_spaceship_unset_when_required(tmp_db):
    from modules import preflight
    r = preflight.check_spaceship_auth(skip_purchase=False)
    assert r["ok"] is False


def test_check_spaceship_partial_creds_fails(tmp_db):
    from database import set_setting
    from modules import preflight
    set_setting("spaceship_api_key", "x")  # only key, no secret
    r = preflight.check_spaceship_auth(skip_purchase=False)
    assert r["ok"] is False
    assert "_SECRET" in r["message"]


# ---------------------------------------------------------------------------
# LLM key
# ---------------------------------------------------------------------------

def test_check_llm_key_unset(tmp_db):
    from modules import preflight
    r = preflight.check_llm_key()
    assert r["ok"] is False


def test_check_llm_key_provider_specific(tmp_db):
    from database import set_setting
    from modules import preflight
    set_setting("llm_provider", "openai")
    set_setting("llm_api_key_openai", "sk-fake")
    r = preflight.check_llm_key()
    assert r["ok"] is True
    assert "openai" in r["message"]


def test_check_llm_key_legacy_global_fallback(tmp_db):
    from database import set_setting
    from modules import preflight
    # No provider-specific key set, but legacy llm_api_key is — should accept.
    set_setting("llm_provider", "anthropic")
    set_setting("llm_api_key", "sk-legacy")
    r = preflight.check_llm_key()
    assert r["ok"] is True


# ---------------------------------------------------------------------------
# Server capacity
# ---------------------------------------------------------------------------

def test_check_server_capacity_no_servers(tmp_db):
    from modules import preflight
    r = preflight.check_server_capacity()
    assert r["ok"] is False
    assert "No ready servers" in r["message"]


def test_check_server_capacity_one_with_room(tmp_db):
    from database import get_db
    from modules import preflight
    conn = get_db()
    conn.execute(
        """INSERT INTO servers (name, ip, status, max_sites)
           VALUES ('a', '1.2.3.4', 'ready', 60)"""
    )
    conn.commit()
    conn.close()
    r = preflight.check_server_capacity()
    assert r["ok"] is True
    assert "1 ready server(s)" in r["message"]


def test_check_server_capacity_all_full(tmp_db):
    from database import get_db
    from modules import preflight
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO servers (name, ip, status, max_sites)
           VALUES ('a', '1.2.3.4', 'ready', 1)"""
    )
    server_id = cur.lastrowid
    # Add a domain pointing at that server so sites_count reaches max_sites.
    conn.execute(
        """INSERT INTO domains (domain, status, server_id)
           VALUES ('x.com', 'live', ?)""",
        (server_id,)
    )
    conn.commit()
    conn.close()
    r = preflight.check_server_capacity()
    assert r["ok"] is False
    assert "at max_sites" in r["message"]


# ---------------------------------------------------------------------------
# Root password
# ---------------------------------------------------------------------------

def test_check_root_password_unset(tmp_db):
    from modules import preflight
    r = preflight.check_root_password()
    assert r["ok"] is False


def test_check_root_password_set(tmp_db):
    from database import set_setting
    from modules import preflight
    set_setting("server_root_password", "x" * 16)
    r = preflight.check_root_password()
    assert r["ok"] is True


# ---------------------------------------------------------------------------
# Aggregate
# ---------------------------------------------------------------------------

def test_run_all_returns_overall_ok_only_when_every_check_passes(tmp_db):
    from modules import preflight
    out = preflight.run_all(skip_purchase=True)
    assert out["ok"] is False  # nothing configured in fresh tmp_db
    assert "checks" in out
    expected = {"cf_pool", "do_token", "sa_auth", "spaceship_auth",
                "llm_key", "server_capacity", "root_password"}
    assert set(out["checks"].keys()) == expected
