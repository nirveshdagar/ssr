"""Tests for migration module — archive round-trip + path validation (L1)."""
import os
import pytest
from modules import migration


def test_archive_path_rejects_traversal():
    """L1: domain with `/` or `..` must raise, not build a path."""
    for bad in ("../etc/passwd", "foo/bar.com", "..", "foo..bar.com",
                "foo.bar..com", "", "  ", "a" * 300):
        with pytest.raises(ValueError):
            migration._archive_path(bad)


def test_archive_path_accepts_good_domains():
    assert migration._archive_path("example.com").endswith("example.com.tar.gz")
    assert migration._archive_path("sub.example.co.uk").endswith(
        "sub.example.co.uk.tar.gz")


def test_archive_round_trip(tmp_db, monkeypatch, tmp_path):
    """archive_site -> read_archive round trip preserves content + metadata."""
    from database import add_domain

    add_domain("roundtrip.test")

    # Swap ARCHIVE_DIR so we don't litter the real data/site_archives/
    monkeypatch.setattr(migration, "ARCHIVE_DIR",
                        str(tmp_path / "archives"))

    php = "<?php echo 'hello'; ?>"
    path = migration.archive_site("roundtrip.test", php, {"niche": "test"})
    assert os.path.exists(path)

    php2, meta = migration.read_archive("roundtrip.test")
    assert php2 == php
    assert meta["niche"] == "test"
    assert meta["domain"] == "roundtrip.test"
    assert meta["bytes"] == len(php.encode("utf-8"))


def test_archive_delete_is_idempotent(tmp_db, monkeypatch, tmp_path):
    """delete_archive returns False when file is missing, True when removed."""
    from database import add_domain

    add_domain("del.test")
    monkeypatch.setattr(migration, "ARCHIVE_DIR",
                        str(tmp_path / "archives"))

    migration.archive_site("del.test", "<?php ?>")
    assert migration.delete_archive("del.test") is True
    # Second call — file already gone
    assert migration.delete_archive("del.test") is False
