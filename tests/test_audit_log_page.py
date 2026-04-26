"""Tests for the dedicated /audit-log page + search_audit_log helper."""
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


def _seed(rows):
    """Insert audit_log rows in order. Each row is a dict of column values."""
    from database import audit
    for r in rows:
        audit(
            action=r["action"],
            target=r.get("target", ""),
            detail=r.get("detail", ""),
            actor_ip=r.get("actor_ip", ""),
        )


# ---------------------------------------------------------------------------
# search_audit_log helper
# ---------------------------------------------------------------------------

def test_search_audit_log_filter_by_action(tmp_db):
    from database import search_audit_log
    _seed([
        {"action": "login_ok", "actor_ip": "1.1.1.1"},
        {"action": "settings_save", "actor_ip": "1.1.1.1"},
        {"action": "login_ok", "actor_ip": "2.2.2.2"},
    ])
    rows, total = search_audit_log(action="login_ok")
    assert total == 2
    assert all(r["action"] == "login_ok" for r in rows)


def test_search_audit_log_substring_search_target(tmp_db):
    from database import search_audit_log
    _seed([
        {"action": "domain_full_delete", "target": "alpha.com"},
        {"action": "domain_full_delete", "target": "beta.io"},
        {"action": "domain_full_delete", "target": "alpha.io"},
    ])
    rows, total = search_audit_log(search="alpha")
    assert total == 2
    targets = sorted(r["target"] for r in rows)
    assert targets == ["alpha.com", "alpha.io"]


def test_search_audit_log_substring_search_detail(tmp_db):
    from database import search_audit_log
    _seed([
        {"action": "x", "detail": "important info"},
        {"action": "y", "detail": "boring"},
    ])
    rows, total = search_audit_log(search="important")
    assert total == 1
    assert rows[0]["detail"] == "important info"


def test_search_audit_log_substring_search_actor_ip(tmp_db):
    from database import search_audit_log
    _seed([
        {"action": "x", "actor_ip": "10.0.0.5"},
        {"action": "y", "actor_ip": "192.168.1.1"},
    ])
    rows, total = search_audit_log(search="10.0.0")
    assert total == 1


def test_search_audit_log_combines_action_and_search(tmp_db):
    from database import search_audit_log
    _seed([
        {"action": "login_ok", "actor_ip": "1.1.1.1"},
        {"action": "login_fail", "actor_ip": "1.1.1.1"},
        {"action": "login_ok", "actor_ip": "9.9.9.9"},
    ])
    rows, total = search_audit_log(action="login_ok", search="1.1.1")
    assert total == 1


def test_search_audit_log_pagination(tmp_db):
    from database import search_audit_log
    _seed([{"action": "x", "detail": f"row-{i}"} for i in range(15)])
    rows, total = search_audit_log(limit=5, offset=0)
    assert len(rows) == 5
    assert total == 15
    rows2, _ = search_audit_log(limit=5, offset=10)
    assert len(rows2) == 5
    # Most-recent-first; rows on page 1 != rows on page 3
    ids1 = {r["id"] for r in rows}
    ids2 = {r["id"] for r in rows2}
    assert ids1.isdisjoint(ids2)


def test_get_audit_log_actions_returns_count(tmp_db):
    from database import get_audit_log_actions
    _seed([
        {"action": "login_ok"}, {"action": "login_ok"}, {"action": "login_ok"},
        {"action": "settings_save"},
    ])
    actions = get_audit_log_actions()
    by_name = {a["action"]: a["n"] for a in actions}
    assert by_name == {"login_ok": 3, "settings_save": 1}
    # Sorted by frequency desc
    assert actions[0]["action"] == "login_ok"


# ---------------------------------------------------------------------------
# /audit-log page
# ---------------------------------------------------------------------------

def test_audit_log_page_renders_empty(client, tmp_db):
    r = client.get("/audit-log")
    assert r.status_code == 200
    assert b"Audit Log" in r.data


def test_audit_log_page_renders_rows(client, tmp_db):
    _seed([
        {"action": "login_ok", "actor_ip": "1.2.3.4", "detail": "login good"},
        {"action": "domain_full_delete", "target": "site.test"},
    ])
    r = client.get("/audit-log")
    assert r.status_code == 200
    body = r.data.decode()
    assert "login_ok" in body
    assert "site.test" in body
    assert "1.2.3.4" in body


def test_audit_log_page_action_filter(client, tmp_db):
    _seed([
        {"action": "login_ok"},
        {"action": "settings_save", "detail": "saved tokens"},
    ])
    r = client.get("/audit-log?action=login_ok")
    body = r.data.decode()
    assert "login_ok" in body
    assert "saved tokens" not in body


def test_audit_log_page_search_filter(client, tmp_db):
    _seed([
        {"action": "x", "target": "matched.com"},
        {"action": "x", "target": "other.com"},
    ])
    r = client.get("/audit-log?q=match")
    body = r.data.decode()
    assert "matched.com" in body
    assert "other.com" not in body


def test_audit_log_page_pagination_links(client, tmp_db):
    """With > PAGE_SIZE rows, the Next link should appear."""
    _seed([{"action": "x", "detail": f"r{i}"} for i in range(60)])
    r = client.get("/audit-log")
    assert b"Page 1 of 2" in r.data or b"Next" in r.data
