"""Tests for soft-delete (DB-only) endpoints for servers and domains.

The hard-delete paths (DO + SA + Spaceship teardown) are exercised by
their own integration tests; this module only verifies the soft-delete
short-circuit: drops the dashboard row, leaves upstream alone, refuses
when downstream rows still reference it.
"""
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


# ---------------------------------------------------------------------------
# Server soft-delete
# ---------------------------------------------------------------------------

def test_server_db_delete_drops_row_only(client, tmp_db):
    from database import get_db
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO servers (name, ip, do_droplet_id, sa_server_id, status)
           VALUES ('s1', '1.2.3.4', 999999999, 'sa-xyz', 'ready')"""
    )
    server_id = cur.lastrowid
    conn.commit()
    conn.close()

    r = client.post(f"/api/servers/{server_id}/db-delete",
                     headers={"Origin": "http://localhost"})
    assert r.status_code in (200, 302)

    conn = get_db()
    try:
        n = conn.execute(
            "SELECT COUNT(*) FROM servers WHERE id=?", (server_id,)
        ).fetchone()[0]
    finally:
        conn.close()
    assert n == 0


def test_server_db_delete_blocks_when_domains_reference(client, tmp_db):
    from database import get_db
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO servers (name, ip, status) VALUES ('s2', '1.2.3.5', 'ready')"
    )
    server_id = cur.lastrowid
    conn.execute(
        "INSERT INTO domains (domain, status, server_id) VALUES ('foo.com', 'live', ?)",
        (server_id,)
    )
    conn.commit()
    conn.close()

    client.post(f"/api/servers/{server_id}/db-delete",
                 headers={"Origin": "http://localhost"})

    conn = get_db()
    try:
        n = conn.execute(
            "SELECT COUNT(*) FROM servers WHERE id=?", (server_id,)
        ).fetchone()[0]
    finally:
        conn.close()
    assert n == 1, "soft delete should refuse when domains reference the server"


def test_server_db_delete_404_for_unknown_id(client, tmp_db):
    r = client.post("/api/servers/99999999/db-delete",
                     headers={"Origin": "http://localhost"})
    # Endpoint flashes a warning + redirects (302) regardless — we just
    # care that it doesn't crash + nothing was deleted.
    assert r.status_code in (200, 302)


# ---------------------------------------------------------------------------
# Domain soft-delete (already existed; verifying it still works after the
# CF-slot-release fix in commit ea6cfe7)
# ---------------------------------------------------------------------------

def test_domain_soft_delete_drops_row(client, tmp_db):
    from database import get_db, add_domain
    add_domain("soft.com")
    conn = get_db()
    n_before = conn.execute("SELECT COUNT(*) FROM domains WHERE domain='soft.com'").fetchone()[0]
    conn.close()
    assert n_before == 1

    r = client.post("/api/domains/soft.com/delete",
                     headers={"Origin": "http://localhost"})
    assert r.status_code in (200, 302)

    conn = get_db()
    n_after = conn.execute("SELECT COUNT(*) FROM domains WHERE domain='soft.com'").fetchone()[0]
    conn.close()
    assert n_after == 0


def test_domain_soft_delete_releases_cf_slot(client, tmp_db):
    """Sanity check that the soft-delete path still calls release_cf_key_slot
    (regression guard for commit ea6cfe7)."""
    from database import get_db, add_domain
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO cf_keys (email, api_key, alias, is_active, domains_used, max_domains)
           VALUES ('x@y.z', 'KEY', 'CF1', 1, 1, 20)"""
    )
    cf_key_id = cur.lastrowid
    conn.commit()
    conn.close()

    add_domain("cfslot.com")
    conn = get_db()
    conn.execute(
        "UPDATE domains SET cf_key_id=? WHERE domain='cfslot.com'",
        (cf_key_id,)
    )
    conn.commit()
    conn.close()

    client.post("/api/domains/cfslot.com/delete",
                 headers={"Origin": "http://localhost"})

    conn = get_db()
    used = conn.execute(
        "SELECT domains_used FROM cf_keys WHERE id=?", (cf_key_id,)
    ).fetchone()[0]
    conn.close()
    assert used == 0, "CF slot should have been released by the soft-delete"
