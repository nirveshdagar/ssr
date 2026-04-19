"""Shared pytest fixtures. Lets us swap the DB path out so tests can run
against a scratch file instead of the real data/ssr.db.
"""
import os
import sys
import tempfile

import pytest

# Make the project root importable from tests/
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def tmp_db(tmp_path, monkeypatch):
    """Swap database.DB_PATH to a fresh file for the duration of a test.

    Uses monkeypatch so concurrent tests don't step on each other, and the
    real data/ssr.db is never touched.
    """
    import database as db
    test_db = tmp_path / "test.db"
    monkeypatch.setattr(db, "DB_PATH", str(test_db))
    db.init_db()
    yield str(test_db)
