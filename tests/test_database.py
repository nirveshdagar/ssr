"""Tests for database primitives: computed sites_count (R1/R2),
idempotent add_domain, audit log."""
from database import (
    get_db, get_servers, add_server, add_domain, update_domain,
    audit, get_audit_log, get_domains,
)


def test_computed_sites_count_ignores_stored_column(tmp_db):
    """R1/R2: sites_count returned by get_servers() equals actual domain count,
    even when the stored sites_count column is wildly wrong."""
    sid = add_server("srv1", "1.1.1.1", "droplet-1")
    conn = get_db()
    conn.execute("UPDATE servers SET sites_count=999 WHERE id=?", (sid,))
    conn.commit()
    conn.close()

    # No domains yet — should still report 0
    srv = next(s for s in get_servers() if s["id"] == sid)
    assert srv["sites_count"] == 0

    # Add 2 domains assigned to this server
    add_domain("a.test"); update_domain("a.test", server_id=sid)
    add_domain("b.test"); update_domain("b.test", server_id=sid)

    srv = next(s for s in get_servers() if s["id"] == sid)
    assert srv["sites_count"] == 2


def test_add_domain_is_idempotent(tmp_db):
    add_domain("idem.test")
    add_domain("idem.test")  # second call must not raise
    add_domain("idem.test")
    domains = [d["domain"] for d in get_domains()]
    assert domains.count("idem.test") == 1


def test_audit_log_append_and_retrieve(tmp_db):
    audit("test_action", target="domain.test", actor_ip="127.0.0.1",
          detail="unit test")
    audit("test_action2", target="srv-1", actor_ip="1.2.3.4")
    rows = get_audit_log(limit=10)
    actions = [r["action"] for r in rows]
    assert "test_action" in actions
    assert "test_action2" in actions
