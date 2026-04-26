"""Durable, DB-backed job queue.

Replaces the daemon-thread spawns scattered through app.py and pipeline.py
so pipeline runs, server-create flows, and full-delete teardowns survive a
Flask restart instead of dying mid-step.

DESIGN
  - Single in-process worker thread polls the `jobs` table every POLL_INTERVAL,
    claims one queued job at a time, runs the registered handler, updates
    status. The QUEUE is durable; the worker is still in-process. Multi-process
    workers can come in v2.
  - Handlers are registered by string kind ("pipeline.full", etc.) at module
    load time in app.py and dispatched by the worker.
  - Boot recovery: any row stuck in 'running' from a prior process gets reset
    to 'queued' (if attempts left) or 'failed' (if exhausted).
  - Cancellation: the existing per-domain cancel_requested flag still handles
    in-flight pipeline cancels via _check_cancel() at step boundaries.
    cancel_queued_job() flips a queued-but-not-yet-running job to 'canceled'.

LIMITATIONS (acknowledged)
  - Single worker → jobs serialize. Today's daemon threads ran in parallel.
    Tradeoff for durability + simplicity. Worker pool is a v2 concern.
  - No retry backoff. attempt_count gates against runaway retries via
    max_attempts (default 1).
  - FIFO by id; no priorities.
"""

from __future__ import annotations

import json
import os
import threading
import time
import traceback
from typing import Callable

from database import get_db


# Registered handlers — populated by register_handler() at import time in app.py.
_handlers: dict[str, Callable[[dict], None]] = {}

# Worker singleton. Only one worker per process; start_worker is idempotent.
_worker_thread: threading.Thread | None = None
_worker_stop = threading.Event()
_worker_lock = threading.Lock()
_worker_id = f"pid-{os.getpid()}"

POLL_INTERVAL = 2.0


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def register_handler(kind: str, fn: Callable[[dict], None]) -> None:
    """Register a handler for a job kind. 1:1 with kinds — re-registering raises."""
    if kind in _handlers:
        raise ValueError(f"handler for {kind!r} already registered")
    _handlers[kind] = fn


def enqueue_job(kind: str, payload: dict, max_attempts: int = 1) -> int:
    """Insert a queued job. Returns the new row id.

    Does NOT validate that `kind` has a handler — handlers can register after
    enqueue (boot sequencing). Dispatch-time errors mark the job failed.
    """
    now = time.time()
    conn = get_db()
    try:
        cur = conn.execute(
            """INSERT INTO jobs
                 (kind, payload_json, status, attempt_count, max_attempts,
                  created_at, updated_at)
               VALUES (?, ?, 'queued', 0, ?, ?, ?)""",
            (kind, json.dumps(payload), max_attempts, now, now),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def get_job(job_id: int) -> dict | None:
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def list_jobs(status: str | None = None, kind: str | None = None,
              limit: int = 50) -> list[dict]:
    where = []
    args: list = []
    if status:
        where.append("status = ?"); args.append(status)
    if kind:
        where.append("kind = ?"); args.append(kind)
    sql = "SELECT * FROM jobs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ?"
    args.append(limit)
    conn = get_db()
    try:
        return [dict(r) for r in conn.execute(sql, args).fetchall()]
    finally:
        conn.close()


def cancel_queued_job(job_id: int) -> bool:
    """Mark a queued job as canceled. Returns True if it transitioned, False
    if it wasn't queued (already running/done/canceled/failed)."""
    now = time.time()
    conn = get_db()
    try:
        cur = conn.execute(
            """UPDATE jobs
                  SET status = 'canceled', updated_at = ?
                WHERE id = ? AND status = 'queued'""",
            (now, job_id),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def recover_orphans() -> int:
    """Boot-time recovery. Any row left in 'running' from a prior process is
    orphaned (its worker is gone). Reset to 'queued' if attempts remain, else
    mark 'failed'. Returns total rows touched.
    """
    now = time.time()
    conn = get_db()
    try:
        # Mark exhausted-attempt orphans failed first (so the requeue UPDATE
        # below doesn't pick them up).
        cur1 = conn.execute(
            """UPDATE jobs
                  SET status = 'failed',
                      last_error = COALESCE(last_error, '')
                                || ' | orphaned: process restarted mid-run',
                      locked_by = NULL,
                      locked_at = NULL,
                      updated_at = ?
                WHERE status = 'running'
                  AND attempt_count >= max_attempts""",
            (now,),
        )
        cur2 = conn.execute(
            """UPDATE jobs
                  SET status = 'queued',
                      locked_by = NULL,
                      locked_at = NULL,
                      updated_at = ?
                WHERE status = 'running'""",
            (now,),
        )
        conn.commit()
        return cur1.rowcount + cur2.rowcount
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Worker internals
# ---------------------------------------------------------------------------

def _claim_one() -> dict | None:
    """Grab the oldest queued job. Returns the post-claim row dict (with
    bumped attempt_count + 'running' status) or None if queue is empty.

    With a single worker this is race-free; the `AND status = 'queued'`
    guard on the UPDATE makes it safe if a v2 multi-worker setup ever lands.
    """
    now = time.time()
    conn = get_db()
    try:
        row = conn.execute(
            """SELECT id FROM jobs
                WHERE status = 'queued'
                ORDER BY id
                LIMIT 1"""
        ).fetchone()
        if not row:
            return None
        cur = conn.execute(
            """UPDATE jobs
                  SET status = 'running',
                      attempt_count = attempt_count + 1,
                      locked_by = ?,
                      locked_at = ?,
                      updated_at = ?
                WHERE id = ? AND status = 'queued'""",
            (_worker_id, now, now, row["id"]),
        )
        conn.commit()
        if cur.rowcount == 0:
            # Lost the race to another worker — try again next tick.
            return None
        claimed = conn.execute(
            "SELECT * FROM jobs WHERE id = ?", (row["id"],)
        ).fetchone()
        return dict(claimed) if claimed else None
    finally:
        conn.close()


def _finish(job_id: int, status: str, error: str | None = None) -> None:
    now = time.time()
    conn = get_db()
    try:
        conn.execute(
            """UPDATE jobs
                  SET status = ?,
                      last_error = ?,
                      locked_by = NULL,
                      locked_at = NULL,
                      updated_at = ?
                WHERE id = ?""",
            (status, error, now, job_id),
        )
        conn.commit()
    finally:
        conn.close()


def _requeue_for_retry(job_id: int, error: str) -> None:
    now = time.time()
    conn = get_db()
    try:
        conn.execute(
            """UPDATE jobs
                  SET status = 'queued',
                      last_error = ?,
                      locked_by = NULL,
                      locked_at = NULL,
                      updated_at = ?
                WHERE id = ?""",
            (error, now, job_id),
        )
        conn.commit()
    finally:
        conn.close()


def _run_one(job: dict) -> None:
    handler = _handlers.get(job["kind"])
    if handler is None:
        _finish(job["id"], "failed",
                f"No handler registered for kind={job['kind']!r}")
        return
    try:
        payload = json.loads(job["payload_json"])
    except json.JSONDecodeError as e:
        _finish(job["id"], "failed", f"Bad payload JSON: {e}")
        return
    try:
        handler(payload)
        _finish(job["id"], "done")
    except Exception as e:
        tb = traceback.format_exc()[:4000]
        err = f"{type(e).__name__}: {e}\n{tb}"
        # attempt_count was bumped at claim time, so it now reflects this attempt.
        if job["attempt_count"] < job["max_attempts"]:
            _requeue_for_retry(job["id"], err)
        else:
            _finish(job["id"], "failed", err)


def _worker_loop() -> None:
    while not _worker_stop.is_set():
        try:
            job = _claim_one()
        except Exception:
            # If we can't even claim (DB lock contention, schema mismatch), back
            # off and retry rather than spin a tight failure loop.
            _worker_stop.wait(POLL_INTERVAL * 2)
            continue
        if job is None:
            _worker_stop.wait(POLL_INTERVAL)
            continue
        _run_one(job)


def start_worker() -> None:
    """Idempotently start the in-process worker thread. Safe to call multiple
    times — extra calls are no-ops while the existing worker is alive.
    """
    global _worker_thread
    with _worker_lock:
        if _worker_thread and _worker_thread.is_alive():
            return
        _worker_stop.clear()
        _worker_thread = threading.Thread(
            target=_worker_loop, daemon=True, name="ssr-job-worker"
        )
        _worker_thread.start()


def stop_worker(timeout: float = 5.0) -> None:
    """Stop the worker. Used in tests. The current job, if any, finishes —
    handlers aren't interrupted."""
    _worker_stop.set()
    if _worker_thread:
        _worker_thread.join(timeout=timeout)
