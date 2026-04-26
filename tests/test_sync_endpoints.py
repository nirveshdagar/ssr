"""Tests for sync-from-upstream endpoints (orphan removal).

DO and SA upstream calls are mocked at the module-function level so the
tests don't require live tokens. The endpoints under test are thin
glue — verifying:
  - rows whose upstream is gone get removed
  - rows whose upstream is present are preserved
  - referenced rows are not cascade-orphaned
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
# Servers: sync from DO
# ---------------------------------------------------------------------------

def test_sync_from_do_removes_orphans(client, tmp_db, monkeypatch):
    """Server with do_droplet_id NOT in DO's live list → removed."""
    from database import get_db
    conn = get_db()
    conn.executemany(
        "INSERT INTO servers (name, ip, do_droplet_id, status) VALUES (?, ?, ?, 'ready')",
        [("alive", "1.1.1.1", 100), ("dead", "2.2.2.2", 200)]
    )
    conn.commit()
    conn.close()

    # DO returns only droplet 100 — droplet 200 is gone.
    from modules import digitalocean
    monkeypatch.setattr(digitalocean, "list_droplets",
                        lambda *a, **kw: [{"id": 100}])

    r = client.post("/api/servers/sync-from-do",
                     headers={"Origin": "http://localhost"})
    assert r.status_code in (200, 302)

    conn = get_db()
    names = sorted(r["name"] for r in conn.execute("SELECT name FROM servers"))
    conn.close()
    assert names == ["alive"]


def test_sync_from_do_preserves_referenced_servers(client, tmp_db, monkeypatch):
    """A server whose DO droplet is gone but which still has domains
    referencing it must NOT be auto-removed (would cascade-orphan)."""
    from database import get_db
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO servers (name, ip, do_droplet_id, status) VALUES ('referenced', '3.3.3.3', 300, 'ready')"
    )
    server_id = cur.lastrowid
    conn.execute(
        "INSERT INTO domains (domain, status, server_id) VALUES ('x.com', 'live', ?)",
        (server_id,)
    )
    conn.commit()
    conn.close()

    from modules import digitalocean
    monkeypatch.setattr(digitalocean, "list_droplets", lambda *a, **kw: [])

    client.post("/api/servers/sync-from-do",
                 headers={"Origin": "http://localhost"})

    conn = get_db()
    n = conn.execute("SELECT COUNT(*) FROM servers").fetchone()[0]
    conn.close()
    assert n == 1, "referenced server must not have been removed"


def test_sync_from_do_skips_servers_without_droplet_id(client, tmp_db, monkeypatch):
    """Manually-added servers (do_droplet_id NULL) shouldn't be touched."""
    from database import get_db
    conn = get_db()
    conn.execute(
        "INSERT INTO servers (name, ip, status) VALUES ('manual', '4.4.4.4', 'ready')"
    )
    conn.commit()
    conn.close()

    from modules import digitalocean
    monkeypatch.setattr(digitalocean, "list_droplets", lambda *a, **kw: [])

    client.post("/api/servers/sync-from-do",
                 headers={"Origin": "http://localhost"})

    conn = get_db()
    n = conn.execute("SELECT COUNT(*) FROM servers").fetchone()[0]
    conn.close()
    assert n == 1


# ---------------------------------------------------------------------------
# Domains: sync from SA
# ---------------------------------------------------------------------------

def test_sync_from_sa_removes_orphans(client, tmp_db, monkeypatch):
    """A 'live' domain whose SA app is gone gets removed; one whose
    app is still on SA stays."""
    from database import get_db, add_domain
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO servers (name, ip, sa_server_id, status) VALUES ('s1', '5.5.5.5', 'sa-1', 'ready')"
    )
    server_id = cur.lastrowid
    conn.commit()
    conn.close()

    add_domain("alive.com")
    add_domain("dead.com")
    add_domain("pending.com")  # status='pending' — should never be touched
    conn = get_db()
    conn.execute("UPDATE domains SET server_id=?, status='live' WHERE domain='alive.com'", (server_id,))
    conn.execute("UPDATE domains SET server_id=?, status='live' WHERE domain='dead.com'", (server_id,))
    conn.commit()
    conn.close()

    from modules import serveravatar
    # SA returns only alive.com on this server.
    monkeypatch.setattr(serveravatar, "list_applications",
                        lambda sa_id: [{"name": "alive.com"}])

    client.post("/api/domains/sync-from-sa",
                 headers={"Origin": "http://localhost"})

    conn = get_db()
    domains = sorted(r["domain"] for r in conn.execute("SELECT domain FROM domains"))
    conn.close()
    # dead.com gone, alive.com kept, pending.com untouched (pre-hosted state)
    assert domains == ["alive.com", "pending.com"]


def test_sync_from_sa_skips_pre_hosted_states(client, tmp_db, monkeypatch):
    """Domains in pending/detected/cf_assigned/etc. were never on SA.
    Sync should not remove them just because SA doesn't know about them."""
    from database import get_db, add_domain
    add_domain("not-yet.com")
    conn = get_db()
    conn.execute("UPDATE domains SET status='cf_assigned' WHERE domain='not-yet.com'")
    conn.commit()
    conn.close()

    from modules import serveravatar
    monkeypatch.setattr(serveravatar, "list_applications", lambda sa_id: [])

    client.post("/api/domains/sync-from-sa",
                 headers={"Origin": "http://localhost"})

    conn = get_db()
    n = conn.execute("SELECT COUNT(*) FROM domains").fetchone()[0]
    conn.close()
    assert n == 1


def test_sync_from_sa_releases_cf_slot_on_orphan(client, tmp_db, monkeypatch):
    """Same regression-guard as soft-delete: removed domains must release
    their CF key slot."""
    from database import get_db, add_domain
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO cf_keys (email, api_key, alias, is_active, domains_used, max_domains)
           VALUES ('z@y.x', 'KEY', 'CF1', 1, 1, 20)"""
    )
    cf_key_id = cur.lastrowid
    cur = conn.execute(
        "INSERT INTO servers (name, ip, sa_server_id, status) VALUES ('s', '6.6.6.6', 'sa-2', 'ready')"
    )
    server_id = cur.lastrowid
    conn.commit()
    conn.close()

    add_domain("orphan.com")
    conn = get_db()
    conn.execute(
        "UPDATE domains SET server_id=?, status='live', cf_key_id=? WHERE domain='orphan.com'",
        (server_id, cf_key_id)
    )
    conn.commit()
    conn.close()

    from modules import serveravatar
    monkeypatch.setattr(serveravatar, "list_applications", lambda sa_id: [])

    client.post("/api/domains/sync-from-sa",
                 headers={"Origin": "http://localhost"})

    conn = get_db()
    used = conn.execute("SELECT domains_used FROM cf_keys WHERE id=?", (cf_key_id,)).fetchone()[0]
    conn.close()
    assert used == 0
