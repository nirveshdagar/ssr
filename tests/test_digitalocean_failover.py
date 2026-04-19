"""Tests for DO failover: DOAllTokensFailed behaviour + cost cap (#3)."""
import time
import pytest
from modules import digitalocean as do


def test_candidate_tokens_respects_primary_then_backup(tmp_db):
    from database import set_setting
    set_setting("do_api_token", "primary-xyz")
    set_setting("do_api_token_backup", "backup-xyz")
    set_setting("do_use_backup_first", "0")
    tokens = do._candidate_tokens()
    labels = [lbl for lbl, _ in tokens]
    assert labels == ["primary", "backup"]


def test_candidate_tokens_flips_with_setting(tmp_db):
    from database import set_setting
    set_setting("do_api_token", "primary")
    set_setting("do_api_token_backup", "backup")
    set_setting("do_use_backup_first", "1")
    tokens = do._candidate_tokens()
    labels = [lbl for lbl, _ in tokens]
    assert labels == ["backup", "primary"]


def test_candidate_tokens_missing_raises(tmp_db):
    from database import set_setting
    set_setting("do_api_token", "")
    set_setting("do_api_token_backup", "")
    with pytest.raises(ValueError):
        do._candidate_tokens()


def test_cost_cap_blocks_on_burst(tmp_db):
    """Issue #3: N rapid-fire create attempts — only the first `cap` go through,
    rest raise DropletRateLimited without touching DO."""
    from database import set_setting
    set_setting("max_droplets_per_hour", "2")

    # Clear the rolling window
    do._droplet_creations.clear()

    # First 2 succeed (no API call — only records)
    do._check_and_record_creation()
    do._check_and_record_creation()
    # Third must raise
    with pytest.raises(do.DropletRateLimited):
        do._check_and_record_creation()

    do._droplet_creations.clear()


def test_cost_cap_rolls_off_after_hour(tmp_db, monkeypatch):
    """A creation older than 3600s must not count against the cap."""
    from database import set_setting
    set_setting("max_droplets_per_hour", "1")
    do._droplet_creations.clear()

    # Plant a stale creation (older than 1h)
    do._droplet_creations.append(time.time() - 3700)

    # Should succeed — the stale one is outside the window
    do._check_and_record_creation()
    do._droplet_creations.clear()


def test_dotokensfailed_carries_attempts():
    attempts = [("primary", "HTTP 401"), ("backup", "HTTP 500")]
    e = do.DOAllTokensFailed(attempts)
    assert e.attempts == attempts
    assert "primary" in str(e)
    assert "backup" in str(e)
