"""Tests for the step-console API endpoints (run history).

The endpoints are thin wrappers around list_pipeline_runs / get_pipeline_run
/ get_step_runs (already tested in test_pipeline_runs.py). These tests
exercise the Flask layer: status codes, JSON shape, auth, 404 handling.
"""
import pytest


@pytest.fixture
def client(tmp_db, monkeypatch):
    """Flask test client with auth bypassed via session."""
    # Force-empty the per-process job-handler registry the app module
    # populates at import time, since two test modules touching the same
    # module-level registry race otherwise.
    import importlib, sys
    if "modules.jobs" in sys.modules:
        sys.modules["modules.jobs"]._handlers.clear()
    if "app" in sys.modules:
        # Force reimport so handlers re-register against the cleared registry.
        del sys.modules["app"]
    import app as _app
    _app.app.config["TESTING"] = True
    with _app.app.test_client() as c:
        with c.session_transaction() as sess:
            sess["authenticated"] = True
        yield c
    # Clean up worker threads spawned by app import.
    try:
        from modules import jobs
        jobs.stop_worker(timeout=1.0)
    except Exception:
        pass


def test_runs_endpoint_returns_recent_runs(client, tmp_db):
    from database import start_pipeline_run, end_pipeline_run
    a = start_pipeline_run("hist.com", {"skip_purchase": True})
    end_pipeline_run(a, "completed")
    b = start_pipeline_run("hist.com")
    end_pipeline_run(b, "failed", error="something")

    r = client.get("/api/domains/hist.com/runs")
    assert r.status_code == 200
    data = r.get_json()
    assert "runs" in data
    ids = [run["id"] for run in data["runs"]]
    # Most-recent-first
    assert ids == [b, a]
    # Status fields preserved
    statuses = [run["status"] for run in data["runs"]]
    assert statuses == ["failed", "completed"]


def test_runs_endpoint_empty_for_unknown_domain(client, tmp_db):
    r = client.get("/api/domains/never.com/runs")
    assert r.status_code == 200
    assert r.get_json() == {"runs": []}


def test_runs_endpoint_honors_limit(client, tmp_db):
    from database import start_pipeline_run
    for _ in range(5):
        start_pipeline_run("limit.com")
    r = client.get("/api/domains/limit.com/runs?limit=2")
    assert r.status_code == 200
    assert len(r.get_json()["runs"]) == 2


def test_run_detail_returns_run_and_steps(client, tmp_db):
    from database import (
        start_pipeline_run, init_steps, update_step,
        set_step_artifact, end_pipeline_run,
    )
    init_steps("d.com")
    run_id = start_pipeline_run("d.com", {"start_from": 3})
    update_step("d.com", 3, "running", "creating zone")
    set_step_artifact("d.com", 3, {"cf_zone_id": "abc"})
    update_step("d.com", 3, "completed", "zone created")
    end_pipeline_run(run_id, "completed")

    r = client.get(f"/api/runs/{run_id}")
    assert r.status_code == 200
    data = r.get_json()
    assert data["run"]["id"] == run_id
    assert data["run"]["domain"] == "d.com"
    assert data["run"]["status"] == "completed"
    assert len(data["steps"]) == 1
    s = data["steps"][0]
    assert s["step_num"] == 3
    assert s["status"] == "completed"
    assert "abc" in (s["artifact_json"] or "")


def test_run_detail_404_for_unknown_run(client, tmp_db):
    r = client.get("/api/runs/9999999")
    assert r.status_code == 404
    assert "error" in r.get_json()


def test_runs_endpoint_requires_auth(tmp_db, monkeypatch):
    """Sanity: unauthed request gets a 401 from /api/* paths (the security
    middleware short-circuits with JSON, not a redirect)."""
    import sys
    if "modules.jobs" in sys.modules:
        sys.modules["modules.jobs"]._handlers.clear()
    if "app" in sys.modules:
        del sys.modules["app"]
    import app as _app
    _app.app.config["TESTING"] = True
    # Set a fake password hash so _has_login_password returns True.
    from database import set_setting
    set_setting("dashboard_password_hash", "x" * 64)
    with _app.app.test_client() as c:
        r = c.get("/api/domains/x.com/runs")
        assert r.status_code == 401
    try:
        from modules import jobs
        jobs.stop_worker(timeout=1.0)
    except Exception:
        pass
