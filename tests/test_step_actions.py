"""Tests for the per-step action endpoints (retry-from-step + override-field)."""
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
# Run-from-step
# ---------------------------------------------------------------------------

def test_run_from_step_enqueues_with_correct_start_from(client, tmp_db, monkeypatch):
    """The endpoint should call run_full_pipeline with start_from set to the
    requested step. We patch run_full_pipeline at the app module level so
    the test verifies the wiring without spinning up the worker."""
    from database import add_domain
    add_domain("retry.com")

    captured = {}
    def fake_run(domain, **kwargs):
        captured["domain"] = domain
        captured["kwargs"] = kwargs
        return 999  # job id
    import app as _app
    monkeypatch.setattr(_app, "run_full_pipeline", fake_run)

    r = client.post("/api/domains/retry.com/run-from/7",
                     headers={"Origin": "http://localhost"})
    assert r.status_code in (200, 302)
    assert captured["domain"] == "retry.com"
    assert captured["kwargs"]["start_from"] == 7


def test_run_from_step_rejects_out_of_range(client, tmp_db, monkeypatch):
    called = {"n": 0}
    def fake_run(*a, **kw):
        called["n"] += 1
        return 1
    import app as _app
    monkeypatch.setattr(_app, "run_full_pipeline", fake_run)

    client.post("/api/domains/x.com/run-from/0",
                 headers={"Origin": "http://localhost"})
    client.post("/api/domains/x.com/run-from/11",
                 headers={"Origin": "http://localhost"})
    assert called["n"] == 0, "out-of-range step nums should not enqueue"


def test_run_from_step_propagates_skip_purchase(client, tmp_db, monkeypatch):
    captured = {}
    def fake_run(domain, **kwargs):
        captured.update(kwargs)
        return 1
    import app as _app
    monkeypatch.setattr(_app, "run_full_pipeline", fake_run)

    client.post("/api/domains/x.com/run-from/3",
                 data={"skip_purchase": "on"},
                 headers={"Origin": "http://localhost"})
    assert captured["skip_purchase"] is True

    captured.clear()
    client.post("/api/domains/x.com/run-from/3",
                 headers={"Origin": "http://localhost"})
    assert captured.get("skip_purchase") is False


# ---------------------------------------------------------------------------
# Override field
# ---------------------------------------------------------------------------

def test_override_field_writes_whitelisted_column(client, tmp_db):
    from database import add_domain, get_domain
    add_domain("ov.com")
    r = client.post("/api/domains/ov.com/override-field",
                     data={"field": "site_html",
                           "value": "<?php echo 'manual'; ?>"},
                     headers={"Origin": "http://localhost"})
    assert r.status_code in (200, 302)
    d = get_domain("ov.com")
    assert d["site_html"] == "<?php echo 'manual'; ?>"


def test_override_field_rejects_non_whitelisted_column(client, tmp_db):
    from database import add_domain, get_domain
    add_domain("ov2.com")
    # Pre-set server_id so we can verify it doesn't get clobbered.
    from database import get_db
    conn = get_db()
    conn.execute("INSERT INTO servers (name, ip, status) VALUES ('s', '1.1.1.1', 'ready')")
    conn.execute("UPDATE domains SET server_id=1 WHERE domain='ov2.com'")
    conn.commit()
    conn.close()

    client.post("/api/domains/ov2.com/override-field",
                 data={"field": "server_id", "value": "999"},
                 headers={"Origin": "http://localhost"})
    d = get_domain("ov2.com")
    assert d["server_id"] == 1, "server_id must NOT be overridable"


def test_override_field_rejects_unknown_field(client, tmp_db):
    from database import add_domain
    add_domain("ov3.com")
    r = client.post("/api/domains/ov3.com/override-field",
                     data={"field": "nope", "value": "x"},
                     headers={"Origin": "http://localhost"})
    # Endpoint flashes + redirects regardless of validity — just confirm
    # nothing crashed and the unknown field didn't somehow land on the row.
    assert r.status_code in (200, 302)
    from database import get_domain
    d = get_domain("ov3.com")
    assert "nope" not in (d.keys() if hasattr(d, "keys") else dict(d))


def test_override_field_status_column_works(client, tmp_db):
    """Status is in the whitelist — operator can manually nudge state."""
    from database import add_domain, get_domain
    add_domain("ov4.com")
    client.post("/api/domains/ov4.com/override-field",
                 data={"field": "status", "value": "owned"},
                 headers={"Origin": "http://localhost"})
    d = get_domain("ov4.com")
    assert d["status"] == "owned"


def test_override_field_rejects_oversize_value(client, tmp_db):
    """A 2 MiB site_html paste exceeds the 1 MiB cap and should be rejected
    with nothing written. Regression guard for the size-cap fix."""
    from database import add_domain, get_domain
    add_domain("big.com")
    huge = "x" * (2 * 1024 * 1024)  # 2 MiB
    client.post("/api/domains/big.com/override-field",
                 data={"field": "site_html", "value": huge},
                 headers={"Origin": "http://localhost"})
    d = get_domain("big.com")
    # Nothing should have been written — site_html stays None/empty.
    assert not (d["site_html"] or "")


def test_override_field_rejects_oversize_status_value(client, tmp_db):
    """status has a tight 64-byte cap; verify it rejects."""
    from database import add_domain, get_domain
    add_domain("bigstat.com")
    over = "z" * 65
    client.post("/api/domains/bigstat.com/override-field",
                 data={"field": "status", "value": over},
                 headers={"Origin": "http://localhost"})
    d = get_domain("bigstat.com")
    # Default status is 'pending' — assert the over-cap value didn't land.
    assert d["status"] != over


def test_override_field_audit_records_old_and_new_lens(client, tmp_db):
    from database import add_domain, get_audit_log
    add_domain("auditme.com")
    # First override sets value
    client.post("/api/domains/auditme.com/override-field",
                 data={"field": "site_html", "value": "abcd"},
                 headers={"Origin": "http://localhost"})
    # Second override replaces it
    client.post("/api/domains/auditme.com/override-field",
                 data={"field": "site_html", "value": "abcdefgh"},
                 headers={"Origin": "http://localhost"})
    rows = get_audit_log(20)
    overrides = [r for r in rows if r["action"] == "domain_override"]
    assert len(overrides) >= 2
    # Most recent first (get_audit_log orders DESC)
    second = overrides[0]["detail"]
    assert "old_len=4" in second
    assert "new_len=8" in second
