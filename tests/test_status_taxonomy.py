"""Tests for the status-taxonomy classification helpers."""
import pytest

from database import (
    is_retryable_error, is_terminal_error, is_error_status,
    RETRYABLE_ERROR_STATUSES, TERMINAL_ERROR_STATUSES,
)


@pytest.mark.parametrize("s,expected", [
    ("retryable_error", True),
    ("error", True),                 # legacy rows pre-split
    ("terminal_error", False),
    ("cf_pool_full", False),
    ("content_blocked", False),
    ("live", False),
    ("hosted", False),
    ("pending", False),
    ("canceled", False),
    ("", False),
    (None, False),
])
def test_is_retryable_error(s, expected):
    assert is_retryable_error(s) is expected


@pytest.mark.parametrize("s,expected", [
    ("terminal_error", True),
    ("cf_pool_full", True),
    ("content_blocked", True),
    ("retryable_error", False),
    ("error", False),
    ("live", False),
    ("hosted", False),
    ("pending", False),
    ("canceled", False),
    ("", False),
    (None, False),
])
def test_is_terminal_error(s, expected):
    assert is_terminal_error(s) is expected


@pytest.mark.parametrize("s,expected", [
    ("retryable_error", True),
    ("terminal_error", True),
    ("error", True),
    ("cf_pool_full", True),
    ("content_blocked", True),
    ("live", False),
    ("hosted", False),
    ("canceled", False),
    ("zone_active", False),
    (None, False),
])
def test_is_error_status(s, expected):
    assert is_error_status(s) is expected


def test_retryable_and_terminal_sets_are_disjoint():
    """A status is one or the other, never both — otherwise the UI badge
    rules get ambiguous and is_error_status double-counts."""
    overlap = RETRYABLE_ERROR_STATUSES & TERMINAL_ERROR_STATUSES
    assert overlap == frozenset(), f"unexpected overlap: {overlap}"


def test_no_pipeline_step_uses_legacy_error_status():
    """Quick guardrail: after the split, no pipeline step should still
    write the bare 'error' status. Legacy 'error' rows from old DB state
    are still readable, but new writes should pick a granular bucket."""
    import pathlib
    src = pathlib.Path(__file__).resolve().parents[1] / "modules" / "pipeline.py"
    text = src.read_text(encoding="utf-8")
    # Allow the audit comment ('legacy error') and conditional checks; only
    # forbid actual writes via update_domain.
    assert 'status="error"' not in text, \
        "modules/pipeline.py still writes status='error' — split into " \
        "retryable_error / terminal_error per the audit"
