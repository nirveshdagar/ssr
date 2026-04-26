"""Tests for the domains-page bulk-list filter (multi-domain exact match)."""
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


def _seed(*names):
    from database import add_domain
    for n in names:
        add_domain(n)


def test_single_token_substring_search_unchanged(client, tmp_db):
    """Old behavior: single q token does substring match."""
    _seed("foo.com", "foobar.io", "other.net")
    r = client.get("/domains?q=foo")
    assert r.status_code == 200
    body = r.data.decode()
    assert "foo.com" in body
    assert "foobar.io" in body
    assert "other.net" not in body


def test_comma_separated_exact_match_list(client, tmp_db):
    """Multi-token mode: only exact name matches show — substring 'foo'
    in 'foobar.io' must NOT include foobar.io when the search is the
    exact list 'foo.com,other.net'."""
    _seed("foo.com", "foobar.io", "other.net", "third.dev")
    r = client.get("/domains?q=foo.com,other.net")
    body = r.data.decode()
    assert "foo.com" in body
    assert "other.net" in body
    assert "foobar.io" not in body, "substring match leaked into bulk-list mode"
    assert "third.dev" not in body


def test_newline_separated_exact_match_list(client, tmp_db):
    """Newline-separated input from a textarea paste: same exact-match
    behavior as comma-separated."""
    _seed("a.com", "b.com", "c.com")
    # \n needs to be URL-encoded for GET — the test client handles that
    # via the data dict OR query_string.
    r = client.get("/domains", query_string={"q": "a.com\nc.com"})
    body = r.data.decode()
    assert "a.com" in body
    assert "c.com" in body
    assert "b.com" not in body


def test_bulk_list_is_case_insensitive(client, tmp_db):
    _seed("UPPER.com", "lower.com", "Mixed.NET")
    r = client.get("/domains", query_string={"q": "upper.com,MIXED.net"})
    body = r.data.decode()
    assert "UPPER.com" in body
    assert "Mixed.NET" in body
    assert "lower.com" not in body


def test_bulk_list_mode_renders_count_summary(client, tmp_db):
    _seed("a.com", "b.com")
    r = client.get("/domains?q=a.com,b.com,nonexistent.com")
    body = r.data.decode()
    assert "Exact-match list mode" in body
    # Two known + one unknown = 2 matches
    assert "2 domain(s) shown" in body


def test_bulk_list_mode_combines_with_status_filter(client, tmp_db):
    """status filter should AND with the bulk-list filter."""
    _seed("a.com", "b.com", "c.com")
    from database import get_db
    conn = get_db()
    conn.execute("UPDATE domains SET status='live' WHERE domain='a.com'")
    conn.execute("UPDATE domains SET status='pending' WHERE domain='b.com'")
    conn.commit()
    conn.close()
    r = client.get("/domains?q=a.com,b.com,c.com&status=live")
    body = r.data.decode()
    # Only a.com is in both the bulk list AND status=live.
    # Look for the row, not just the substring (which could appear in the
    # filter dropdown options too).
    assert "a.com</a>" in body or "a.com</strong>" in body or "a.com<" in body
    # b.com (pending) should be excluded by status filter
    assert "b.com</a>" not in body and "b.com</strong>" not in body


def test_single_token_also_matches_email_field(client, tmp_db):
    """Existing UX: single-token search hits cf_email. Verify still works."""
    from database import add_domain, get_db
    add_domain("d.com")
    conn = get_db()
    conn.execute("UPDATE domains SET cf_email='ops@example.org' WHERE domain='d.com'")
    conn.commit()
    conn.close()
    r = client.get("/domains?q=ops@")
    assert r.status_code == 200
    assert b"d.com" in r.data


def test_empty_q_shows_all_domains(client, tmp_db):
    _seed("x.com", "y.com")
    r = client.get("/domains")
    assert r.status_code == 200
    assert b"x.com" in r.data
    assert b"y.com" in r.data
