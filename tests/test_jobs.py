"""Tests for the durable job queue (modules/jobs.py)."""
import json
import time

import pytest


@pytest.fixture
def jobs_module(tmp_db):
    """Reset the in-process handler registry so each test starts clean."""
    from modules import jobs
    jobs._handlers.clear()
    yield jobs
    jobs._handlers.clear()


def test_enqueue_returns_id_and_persists_payload(jobs_module):
    job_id = jobs_module.enqueue_job("test.kind", {"x": 1, "y": "z"})
    assert job_id > 0
    j = jobs_module.get_job(job_id)
    assert j["status"] == "queued"
    assert j["kind"] == "test.kind"
    assert json.loads(j["payload_json"]) == {"x": 1, "y": "z"}
    assert j["attempt_count"] == 0


def test_handler_dispatch_marks_done(jobs_module):
    received = []
    jobs_module.register_handler("test.echo", lambda p: received.append(p))

    job_id = jobs_module.enqueue_job("test.echo", {"msg": "hello"})
    job = jobs_module._claim_one()
    assert job["id"] == job_id
    assert job["status"] == "running"
    assert job["attempt_count"] == 1

    jobs_module._run_one(job)

    assert received == [{"msg": "hello"}]
    final = jobs_module.get_job(job_id)
    assert final["status"] == "done"
    assert final["last_error"] is None
    assert final["locked_by"] is None


def test_unknown_handler_marks_failed(jobs_module):
    job_id = jobs_module.enqueue_job("test.no_handler", {})
    jobs_module._run_one(jobs_module._claim_one())
    j = jobs_module.get_job(job_id)
    assert j["status"] == "failed"
    assert "No handler" in j["last_error"]


def test_handler_exception_marks_failed_when_attempts_exhausted(jobs_module):
    def boom(payload):
        raise RuntimeError("nope")
    jobs_module.register_handler("test.bad", boom)

    job_id = jobs_module.enqueue_job("test.bad", {}, max_attempts=1)
    jobs_module._run_one(jobs_module._claim_one())

    j = jobs_module.get_job(job_id)
    assert j["status"] == "failed"
    assert "RuntimeError" in j["last_error"]
    assert "nope" in j["last_error"]
    assert j["attempt_count"] == 1


def test_handler_exception_requeues_when_attempts_remain(jobs_module):
    calls = {"n": 0}
    def flaky(payload):
        calls["n"] += 1
        if calls["n"] < 2:
            raise RuntimeError("first attempt fails")
    jobs_module.register_handler("test.flaky", flaky)

    job_id = jobs_module.enqueue_job("test.flaky", {}, max_attempts=2)

    # First run: fails, should requeue.
    jobs_module._run_one(jobs_module._claim_one())
    j = jobs_module.get_job(job_id)
    assert j["status"] == "queued"
    assert j["attempt_count"] == 1
    assert "first attempt fails" in j["last_error"]

    # Second run: succeeds, should mark done.
    jobs_module._run_one(jobs_module._claim_one())
    j = jobs_module.get_job(job_id)
    assert j["status"] == "done"
    assert j["attempt_count"] == 2


def test_orphan_recovery_requeues_running_with_attempts_left(jobs_module):
    from database import get_db
    now = time.time()
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO jobs (kind, payload_json, status, attempt_count,
                              max_attempts, locked_by, locked_at,
                              created_at, updated_at)
           VALUES ('test.x', '{}', 'running', 0, 3, 'old-pid', ?, ?, ?)""",
        (now, now, now),
    )
    conn.commit()
    job_id = cur.lastrowid
    conn.close()

    n = jobs_module.recover_orphans()
    assert n == 1
    j = jobs_module.get_job(job_id)
    assert j["status"] == "queued"
    assert j["locked_by"] is None
    assert j["locked_at"] is None


def test_orphan_recovery_fails_running_when_attempts_exhausted(jobs_module):
    from database import get_db
    now = time.time()
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO jobs (kind, payload_json, status, attempt_count,
                              max_attempts, created_at, updated_at)
           VALUES ('test.x', '{}', 'running', 1, 1, ?, ?)""",
        (now, now),
    )
    conn.commit()
    job_id = cur.lastrowid
    conn.close()

    jobs_module.recover_orphans()
    j = jobs_module.get_job(job_id)
    assert j["status"] == "failed"
    assert "orphaned" in (j["last_error"] or "")


def test_cancel_queued_job_only_works_on_queued_rows(jobs_module):
    job_id = jobs_module.enqueue_job("test.x", {})
    assert jobs_module.cancel_queued_job(job_id) is True
    assert jobs_module.get_job(job_id)["status"] == "canceled"

    # Already canceled — no-op.
    assert jobs_module.cancel_queued_job(job_id) is False


def test_register_handler_rejects_duplicate(jobs_module):
    jobs_module.register_handler("test.dup", lambda p: None)
    with pytest.raises(ValueError, match="already registered"):
        jobs_module.register_handler("test.dup", lambda p: None)


def test_claim_one_returns_none_when_queue_empty(jobs_module):
    assert jobs_module._claim_one() is None


def test_jobs_run_in_fifo_order(jobs_module):
    seen = []
    jobs_module.register_handler("test.order", lambda p: seen.append(p["i"]))

    ids = [jobs_module.enqueue_job("test.order", {"i": i}) for i in range(3)]
    for _ in ids:
        job = jobs_module._claim_one()
        jobs_module._run_one(job)

    assert seen == [0, 1, 2]
