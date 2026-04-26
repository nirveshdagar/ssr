"""Tests for the per-server edit endpoint (name + max_sites)."""
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


def _make_server(tmp_db, name="srv", max_sites=60):
    from database import get_db
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO servers (name, ip, status, max_sites) VALUES (?, '1.2.3.4', 'ready', ?)",
        (name, max_sites)
    )
    conn.commit()
    sid = cur.lastrowid
    conn.close()
    return sid


def test_edit_server_updates_name_and_max_sites(client, tmp_db):
    sid = _make_server(tmp_db, name="old", max_sites=60)
    client.post(
        f"/api/servers/{sid}/edit",
        data={"name": "new-name", "max_sites": "100"},
        headers={"Origin": "http://localhost"},
    )
    from database import get_db
    conn = get_db()
    row = conn.execute("SELECT name, max_sites FROM servers WHERE id=?", (sid,)).fetchone()
    conn.close()
    assert row["name"] == "new-name"
    assert row["max_sites"] == 100


def test_edit_server_rejects_max_below_1(client, tmp_db):
    sid = _make_server(tmp_db, name="x", max_sites=60)
    client.post(
        f"/api/servers/{sid}/edit",
        data={"name": "x", "max_sites": "0"},
        headers={"Origin": "http://localhost"},
    )
    from database import get_db
    conn = get_db()
    n = conn.execute("SELECT max_sites FROM servers WHERE id=?", (sid,)).fetchone()[0]
    conn.close()
    assert n == 60  # unchanged


def test_edit_server_rejects_max_above_500(client, tmp_db):
    sid = _make_server(tmp_db, name="x", max_sites=60)
    client.post(
        f"/api/servers/{sid}/edit",
        data={"name": "x", "max_sites": "9999"},
        headers={"Origin": "http://localhost"},
    )
    from database import get_db
    conn = get_db()
    n = conn.execute("SELECT max_sites FROM servers WHERE id=?", (sid,)).fetchone()[0]
    conn.close()
    assert n == 60


def test_edit_server_rejects_empty_name(client, tmp_db):
    sid = _make_server(tmp_db, name="orig", max_sites=60)
    client.post(
        f"/api/servers/{sid}/edit",
        data={"name": "", "max_sites": "60"},
        headers={"Origin": "http://localhost"},
    )
    from database import get_db
    conn = get_db()
    name = conn.execute("SELECT name FROM servers WHERE id=?", (sid,)).fetchone()[0]
    conn.close()
    assert name == "orig"


def test_edit_server_rejects_garbage_max(client, tmp_db):
    sid = _make_server(tmp_db, name="x", max_sites=60)
    client.post(
        f"/api/servers/{sid}/edit",
        data={"name": "x", "max_sites": "not-a-number"},
        headers={"Origin": "http://localhost"},
    )
    from database import get_db
    conn = get_db()
    n = conn.execute("SELECT max_sites FROM servers WHERE id=?", (sid,)).fetchone()[0]
    conn.close()
    assert n == 60


def test_edit_server_404_on_unknown_id(client, tmp_db):
    r = client.post(
        "/api/servers/999999/edit",
        data={"name": "x", "max_sites": "60"},
        headers={"Origin": "http://localhost"},
    )
    # Endpoint flashes 'Server not found' + redirects (302) regardless;
    # we just want it to not 500.
    assert r.status_code in (200, 302)


def test_max_sites_actually_gates_pipeline_step6(tmp_db):
    """Behavior check: _find_server should skip a server whose
    sites_count >= max_sites — confirms the editable cap is respected."""
    from database import get_db, add_domain
    from modules import pipeline as _pl
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO servers (name, ip, sa_server_id, status, max_sites) "
        "VALUES ('s1', '1.1.1.1', 'sa-1', 'ready', 1)"
    )
    sid = cur.lastrowid
    conn.commit()
    conn.close()
    add_domain("filler.com")
    conn = get_db()
    conn.execute("UPDATE domains SET server_id=?, status='live' WHERE domain='filler.com'", (sid,))
    conn.commit()
    conn.close()

    # Bypass the SA ping that _find_server normally does
    import unittest.mock as _mock
    with _mock.patch.object(_pl, "_verify_sa_server_or_mark_dead", lambda s: True):
        result = _pl._find_server()
    assert result is None, "_find_server returned a server at max_sites"
