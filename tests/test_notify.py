"""Tests for the notifier — dedupe (F4) + provider dispatch."""
import time
from modules import notify


def test_dedupe_blocks_duplicate_key(tmp_db):
    """Same dedupe_key within window → second call skipped."""
    from database import set_setting
    set_setting("notifications_enabled", "1")

    # Clear any prior state for this key
    notify._last_fired.pop("dedupe_unit_test_1", None)

    r1 = notify.notify("t", "b", dedupe_key="dedupe_unit_test_1", blocking=True)
    assert "skipped" not in r1
    r2 = notify.notify("t", "b", dedupe_key="dedupe_unit_test_1", blocking=True)
    assert "skipped" in r2
    assert "deduped" in r2["skipped"]


def test_dedupe_different_keys_dont_interfere(tmp_db):
    from database import set_setting
    set_setting("notifications_enabled", "1")
    notify._last_fired.pop("k1", None); notify._last_fired.pop("k2", None)

    r1 = notify.notify("t", "b", dedupe_key="k1", blocking=True)
    r2 = notify.notify("t", "b", dedupe_key="k2", blocking=True)  # different key
    assert "skipped" not in r1
    assert "skipped" not in r2


def test_master_switch_off(tmp_db):
    from database import set_setting
    set_setting("notifications_enabled", "0")
    r = notify.notify("t", "b", blocking=True)
    assert r.get("skipped") == "notifications_enabled is off"


def test_whatsapp_dispatch_uses_provider(tmp_db, monkeypatch):
    """whatsapp_provider='greenapi' routes to greenapi sender, default to callmebot."""
    from database import set_setting

    called = []
    def fake_cm(subj, body): called.append("callmebot"); return (False, "x")
    def fake_ga(subj, body): called.append("greenapi"); return (False, "y")
    monkeypatch.setattr(notify, "_send_whatsapp_callmebot", fake_cm)
    monkeypatch.setattr(notify, "_send_whatsapp_greenapi", fake_ga)

    set_setting("whatsapp_provider", "")  # default path
    notify._send_whatsapp("s", "b")
    assert called[-1] == "callmebot"

    set_setting("whatsapp_provider", "greenapi")
    notify._send_whatsapp("s", "b")
    assert called[-1] == "greenapi"


def test_server_dead_helper_uses_per_server_dedupe_key(tmp_db, monkeypatch):
    """notify_server_dead(42, ...) must use 'server_dead:42' as dedupe key."""
    from database import set_setting
    set_setting("notifications_enabled", "1")
    notify._last_fired.pop("server_dead:42", None)

    calls = []
    orig = notify.notify
    def capture(*a, **kw): calls.append(kw.get("dedupe_key")); return orig(*a, **kw)
    monkeypatch.setattr(notify, "notify", capture)

    notify.notify_server_dead(42, "srv-42", "1.2.3.4", 5)
    assert calls[0] == "server_dead:42"
