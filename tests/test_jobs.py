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


def test_workers_run_jobs_in_parallel(jobs_module):
    """Two jobs whose handlers each sleep 1s should finish in ~1s wall clock,
    not ~2s, when the pool size is >= 2. This is the load-bearing test for
    the multi-thread pool — if it regresses to single-worker, this fails."""
    import threading
    import time

    barrier = threading.Barrier(2, timeout=3.0)
    completed = []
    completed_lock = threading.Lock()

    def handler(payload):
        # Both handlers must reach the barrier within 3s. If only one worker
        # is running them, the second handler never reaches the barrier
        # before the first finishes its sleep, and barrier.wait() times out.
        try:
            barrier.wait()
        except threading.BrokenBarrierError:
            with completed_lock:
                completed.append(("timeout", payload["i"]))
            return
        time.sleep(0.2)  # tiny extra so we can observe both completing
        with completed_lock:
            completed.append(("ok", payload["i"]))

    jobs_module.register_handler("test.parallel", handler)

    jobs_module.enqueue_job("test.parallel", {"i": 0})
    jobs_module.enqueue_job("test.parallel", {"i": 1})

    # Override the poll interval so workers grab jobs quickly.
    jobs_module.POLL_INTERVAL = 0.05

    start = time.time()
    jobs_module.start_worker(num_workers=2)
    try:
        # Wait for both jobs to finish — give it 5s ceiling.
        deadline = start + 5.0
        while time.time() < deadline:
            with completed_lock:
                if len(completed) == 2:
                    break
            time.sleep(0.05)
    finally:
        jobs_module.stop_worker(timeout=3.0)

    elapsed = time.time() - start
    assert len(completed) == 2, f"jobs didn't finish in time: {completed}"
    statuses = [c[0] for c in completed]
    assert statuses == ["ok", "ok"], \
        f"workers ran serially (barrier timed out): {completed}"
    # Both jobs ran in parallel → ~0.2s each, total ~0.2s. Generous ceiling
    # for CI flakiness.
    assert elapsed < 2.0, f"jobs serialized despite pool size 2: {elapsed:.2f}s"


def test_start_worker_idempotent_with_pool(jobs_module):
    jobs_module.start_worker(num_workers=2)
    try:
        first_pool = list(jobs_module._worker_threads)
        jobs_module.start_worker(num_workers=2)  # should be a no-op
        second_pool = list(jobs_module._worker_threads)
        assert first_pool == second_pool
    finally:
        jobs_module.stop_worker(timeout=2.0)


def test_bulk_pipeline_runs_serially_via_single_bulk_job(tmp_db):
    """Audit P1 #4 regression guard: with a multi-worker pool the OLD
    'enqueue N pipeline.full jobs' approach lost the rate-limit-avoidance
    serialization. The fix enqueues ONE pipeline.bulk job whose handler
    iterates internally, so even with 4 pool workers the batch domains
    run in lockstep on a single worker.
    """
    from modules import pipeline, jobs
    from database import add_domain

    jobs._handlers.clear()
    for d in ("a.com", "b.com", "c.com"):
        add_domain(d)

    # Track concurrent vs. sequential execution
    import threading, time
    in_handler = []
    in_handler_lock = threading.Lock()
    max_concurrent = {"n": 0}

    def fake_pipeline_worker(domain, *_a, **_kw):
        with in_handler_lock:
            in_handler.append(domain)
            max_concurrent["n"] = max(max_concurrent["n"], len(in_handler))
        time.sleep(0.05)
        with in_handler_lock:
            in_handler.remove(domain)

    # Patch the inner worker so we don't need real upstream calls.
    import unittest.mock as _mock
    with _mock.patch.object(pipeline, "_pipeline_worker", side_effect=fake_pipeline_worker):
        jobs.register_handler("pipeline.bulk", pipeline.pipeline_bulk_handler)
        # Enqueue + drive the queue manually so we don't have to rely on
        # the live worker thread timing.
        jobs.run_bulk_pipeline_job_id = pipeline.run_bulk_pipeline(
            ["a.com", "b.com", "c.com"]
        )
        # One job in the queue (a SINGLE pipeline.bulk, not 3 pipeline.full)
        bulk_jobs = jobs.list_jobs(kind="pipeline.bulk", status="queued")
        assert len(bulk_jobs) == 1, "should enqueue ONE bulk job, not N pipeline.full"
        full_jobs = jobs.list_jobs(kind="pipeline.full")
        assert len(full_jobs) == 0, "bulk path must not emit pipeline.full jobs"
        # Drive it
        job = jobs._claim_one()
        jobs._run_one(job)

    # All three domains processed; max concurrent must be 1.
    assert max_concurrent["n"] == 1, \
        f"bulk handler ran domains concurrently (max={max_concurrent['n']})"
