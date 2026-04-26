"""Tests for the dedicated Cloudflare management page + edit endpoint."""
import pytest


@pytest.fixture
def client(tmp_db):
    import sys
    if "modules.jobs" in sys.modules:
        sys.modules["modules.jobs"]._handlers.clear()
    if "app" in sys.modules:
        del sys.modules["app"]
    import app as _app
    _app.app.config["TESTING"] = True
    with _app.app.test_client() as c:
        with c.session_transaction() as sess:
            sess["authenticated"] = True
        yield c
    try:
        from modules import jobs
        jobs.stop_worker(timeout=1.0)
    except Exception:
        pass


def test_cloudflare_page_renders_empty(client, tmp_db):
    r = client.get("/cloudflare")
    assert r.status_code == 200
    assert b"Cloudflare Management" in r.data
    assert b"No CF keys in pool yet" in r.data


def test_cloudflare_page_renders_keys(client, tmp_db):
    from database import get_db
    conn = get_db()
    conn.execute(
        """INSERT INTO cf_keys (email, api_key, cf_account_id, alias, is_active,
                                  domains_used, max_domains)
           VALUES ('a@b.c', 'KEYABCDEF1234', 'acct1234567890', 'CF1', 1, 5, 20)"""
    )
    conn.commit()
    conn.close()
    r = client.get("/cloudflare")
    assert r.status_code == 200
    # Alias is visible
    assert b"CF1" in r.data
    # Email is visible
    assert b"a@b.c" in r.data
    # Key is masked by default (first 6 + last 4)
    assert b"KEYABC" in r.data
    assert b"1234" in r.data
    # Used / max numbers shown
    assert b"5/20" in r.data


def test_cf_key_edit_updates_alias_and_max(client, tmp_db):
    from database import get_db
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO cf_keys (email, api_key, cf_account_id, alias, is_active,
                                  domains_used, max_domains)
           VALUES ('a@b.c', 'KEY', 'acct', 'old', 1, 0, 20)"""
    )
    key_id = cur.lastrowid
    conn.commit()
    conn.close()

    client.post(f"/api/cf-keys/{key_id}/edit",
                 data={"alias": "new-alias", "max_domains": "50"},
                 headers={"Origin": "http://localhost"})

    conn = get_db()
    row = conn.execute(
        "SELECT alias, max_domains FROM cf_keys WHERE id=?", (key_id,)
    ).fetchone()
    conn.close()
    assert row["alias"] == "new-alias"
    assert row["max_domains"] == 50


def test_cf_key_edit_rejects_out_of_range_max(client, tmp_db):
    from database import get_db
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO cf_keys (email, api_key, cf_account_id, max_domains)
           VALUES ('a@b.c', 'KEY', 'acct', 20)"""
    )
    key_id = cur.lastrowid
    conn.commit()
    conn.close()

    # Negative
    client.post(f"/api/cf-keys/{key_id}/edit",
                 data={"alias": "", "max_domains": "-5"},
                 headers={"Origin": "http://localhost"})
    # Far too high
    client.post(f"/api/cf-keys/{key_id}/edit",
                 data={"alias": "", "max_domains": "99999"},
                 headers={"Origin": "http://localhost"})

    conn = get_db()
    row = conn.execute("SELECT max_domains FROM cf_keys WHERE id=?", (key_id,)).fetchone()
    conn.close()
    assert row["max_domains"] == 20  # unchanged


def test_cf_endpoints_redirect_to_cloudflare_page(client, tmp_db):
    """All cf-keys endpoints should redirect to /cloudflare now (not /settings)."""
    from database import get_db
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO cf_keys (email, api_key, cf_account_id, max_domains, is_active)
           VALUES ('x@y.z', 'KEY', 'acct', 20, 1)"""
    )
    key_id = cur.lastrowid
    conn.commit()
    conn.close()

    # Toggle
    r = client.post(f"/api/cf-keys/{key_id}/toggle",
                     headers={"Origin": "http://localhost"})
    assert r.status_code == 302
    assert "/cloudflare" in r.headers["Location"]

    # Edit
    r = client.post(f"/api/cf-keys/{key_id}/edit",
                     data={"alias": "x", "max_domains": "20"},
                     headers={"Origin": "http://localhost"})
    assert r.status_code == 302
    assert "/cloudflare" in r.headers["Location"]

    # Delete
    r = client.post(f"/api/cf-keys/{key_id}/delete",
                     headers={"Origin": "http://localhost"})
    assert r.status_code == 302
    assert "/cloudflare" in r.headers["Location"]
