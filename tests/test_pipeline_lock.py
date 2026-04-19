"""Tests for the per-domain pipeline slot lock (F1 / R3 / R6)."""
from modules.pipeline import (
    _try_acquire_slot, _release_slot, is_pipeline_running,
)


def test_slot_acquire_release_cycle():
    d = "slot-test.example"
    # Clean start
    _release_slot(d)

    assert _try_acquire_slot(d) is True
    assert is_pipeline_running(d) is True
    assert _try_acquire_slot(d) is False  # second acquire blocked
    _release_slot(d)
    assert is_pipeline_running(d) is False
    assert _try_acquire_slot(d) is True   # reacquire works after release
    _release_slot(d)


def test_slot_independent_across_domains():
    a, b = "a.example", "b.example"
    _release_slot(a); _release_slot(b)

    assert _try_acquire_slot(a) is True
    assert _try_acquire_slot(b) is True  # different domain — independent lock
    assert is_pipeline_running(a) is True
    assert is_pipeline_running(b) is True
    _release_slot(a); _release_slot(b)
