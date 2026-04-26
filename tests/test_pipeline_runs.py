"""Tests for the per-run state tables (pipeline_runs + pipeline_step_runs)."""
import json
import time

import pytest


def test_start_and_end_pipeline_run_roundtrip(tmp_db):
    from database import (
        start_pipeline_run, end_pipeline_run,
        get_pipeline_run, list_pipeline_runs,
    )
    run_id = start_pipeline_run("foo.com", {"skip_purchase": True})
    assert run_id > 0
    r = get_pipeline_run(run_id)
    assert r["domain"] == "foo.com"
    assert r["status"] == "running"
    assert json.loads(r["params_json"]) == {"skip_purchase": True}
    assert r["started_at"] is not None
    assert r["ended_at"] is None

    end_pipeline_run(run_id, "completed")
    r = get_pipeline_run(run_id)
    assert r["status"] == "completed"
    assert r["ended_at"] is not None
    assert r["error"] is None

    runs = list_pipeline_runs("foo.com")
    assert len(runs) == 1
    assert runs[0]["id"] == run_id


def test_end_pipeline_run_records_error(tmp_db):
    from database import start_pipeline_run, end_pipeline_run, get_pipeline_run
    run_id = start_pipeline_run("bar.com")
    end_pipeline_run(run_id, "failed", error="DNS timeout")
    r = get_pipeline_run(run_id)
    assert r["status"] == "failed"
    assert r["error"] == "DNS timeout"


def test_update_step_writes_to_step_runs_when_run_active(tmp_db):
    from database import (
        start_pipeline_run, init_steps, update_step, get_step_runs,
    )
    run_id = start_pipeline_run("baz.com")
    init_steps("baz.com")

    update_step("baz.com", 1, "running", "Buying domain")
    update_step("baz.com", 1, "completed", "Bought!")

    runs = get_step_runs(run_id)
    assert len(runs) == 1
    sr = runs[0]
    assert sr["step_num"] == 1
    assert sr["status"] == "completed"
    assert sr["message"] == "Bought!"
    assert sr["started_at"] is not None
    assert sr["ended_at"] is not None
    assert sr["attempt"] == 1


def test_update_step_no_active_run_only_touches_step_tracker(tmp_db):
    """When no pipeline_runs row is in 'running' state for the domain, the
    new tables should be untouched. Legacy code paths that call update_step
    without going through the worker wrapper must keep working.
    """
    from database import init_steps, update_step, get_db
    init_steps("nofun.com")
    update_step("nofun.com", 1, "running", "should not create run")
    update_step("nofun.com", 1, "completed", "still no run")

    conn = get_db()
    try:
        runs = conn.execute("SELECT COUNT(*) FROM pipeline_runs").fetchone()[0]
        steps = conn.execute("SELECT COUNT(*) FROM pipeline_step_runs").fetchone()[0]
    finally:
        conn.close()
    assert runs == 0
    assert steps == 0


def test_update_step_picks_only_running_run(tmp_db):
    """If a run is completed and a new one starts, updates should land on
    the NEW (running) run, not the old completed one."""
    from database import (
        start_pipeline_run, end_pipeline_run, init_steps,
        update_step, get_step_runs,
    )
    init_steps("two.com")
    old_run = start_pipeline_run("two.com")
    update_step("two.com", 1, "completed", "first run done")
    end_pipeline_run(old_run, "completed")

    new_run = start_pipeline_run("two.com")
    update_step("two.com", 1, "running", "second run")
    update_step("two.com", 1, "completed", "second run done")

    old_steps = get_step_runs(old_run)
    new_steps = get_step_runs(new_run)
    assert len(old_steps) == 1
    assert old_steps[0]["message"] == "first run done"
    assert len(new_steps) == 1
    assert new_steps[0]["message"] == "second run done"


def test_step_run_started_and_ended_timestamps_stick(tmp_db):
    """Once started_at is set on transition to 'running', a later
    'completed' shouldn't overwrite it. ended_at should be set on the
    first terminal transition and stick across redundant updates."""
    from database import (
        start_pipeline_run, init_steps, update_step, get_step_runs,
    )
    init_steps("ts.com")
    run_id = start_pipeline_run("ts.com")

    update_step("ts.com", 2, "running", "fetching")
    runs = get_step_runs(run_id)
    started = runs[0]["started_at"]
    assert started is not None
    assert runs[0]["ended_at"] is None

    update_step("ts.com", 2, "completed", "fetched")
    runs = get_step_runs(run_id)
    assert runs[0]["started_at"] == started     # unchanged
    ended = runs[0]["ended_at"]
    assert ended is not None

    # Idempotent re-update shouldn't move ended_at backward/forward.
    update_step("ts.com", 2, "completed", "fetched (re-noted)")
    runs = get_step_runs(run_id)
    assert runs[0]["ended_at"] == ended


def test_get_step_runs_orders_by_step_num(tmp_db):
    from database import (
        start_pipeline_run, init_steps, update_step, get_step_runs,
    )
    init_steps("ord.com")
    run_id = start_pipeline_run("ord.com")
    # Update steps out of order — should still come back ordered.
    update_step("ord.com", 5, "completed", "five")
    update_step("ord.com", 1, "completed", "one")
    update_step("ord.com", 3, "completed", "three")
    runs = get_step_runs(run_id)
    assert [r["step_num"] for r in runs] == [1, 3, 5]


def test_list_pipeline_runs_returns_recent_first(tmp_db):
    from database import start_pipeline_run, list_pipeline_runs
    a = start_pipeline_run("multi.com")
    b = start_pipeline_run("multi.com")
    c = start_pipeline_run("multi.com")
    runs = list_pipeline_runs("multi.com")
    assert [r["id"] for r in runs] == [c, b, a]


def test_list_pipeline_runs_filters_by_domain(tmp_db):
    from database import start_pipeline_run, list_pipeline_runs
    start_pipeline_run("a.com")
    start_pipeline_run("b.com")
    start_pipeline_run("a.com")
    a_runs = list_pipeline_runs("a.com")
    b_runs = list_pipeline_runs("b.com")
    assert len(a_runs) == 2
    assert len(b_runs) == 1
    assert all(r["domain"] == "a.com" for r in a_runs)
