"""Background live-checker + dead-server auto-migrator.

Watches every domain in status='hosted'/'live' and flips between them based
on HTTPS responses. ALSO watches for servers where every domain is offline
for a while, marks them 'dead', and spawns migrate_server() to move all
their domains to a healthy server.

Runs in its own daemon thread, started from app.py at Flask boot.

Design goals:
  - Light footprint: one HEAD request per hosted/live domain per pass
  - Survive app restarts: reads current state from DB on every pass
  - Doesn't touch anything not in 'hosted'/'live' state — won't accidentally
    re-check 'error', 'content_blocked', etc.
  - Bumps status back to 'hosted' if a 'live' domain starts failing for
    3 consecutive checks
  - Marks a server 'dead' + auto-migrates its domains when EVERY domain
    on the server has been down for `dead_server_threshold_ticks` (default
    10) consecutive checks. Auto-migrate only runs when the setting
    `auto_migrate_enabled` is '1' — the dead-status flip happens regardless
    so the user sees the detection.
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from database import get_db, log_pipeline, get_setting

# Bounded pool for concurrent HTTPS probes. 20 parallel checks keeps a full
# tick on a 60-domain fleet under ~10s even when many domains time out.
# Without this, serial probes at 8s/timeout × 60 = 480s per tick — would
# far exceed the 60s interval and delay dead-detection by minutes.
_PROBE_MAX_WORKERS = 20


_thread: threading.Thread | None = None
_stop_event = threading.Event()
_streak_up: dict[str, int] = {}      # domain -> consecutive 2xx/3xx count
_streak_down: dict[str, int] = {}    # domain -> consecutive failure count
# Server IDs currently being migrated (avoid spawning duplicate migrate threads
# on successive live-checker ticks while migration is in progress).
_migrating: set[int] = set()
_migrating_lock = threading.Lock()


def _check_one(domain):
    """Return True if https://{domain}/ responds 2xx/3xx within a short timeout."""
    try:
        r = requests.get(
            f"https://{domain}/",
            timeout=8,
            allow_redirects=True,
            headers={"User-Agent": "SSR-live-checker/1.0"},
            verify=True,  # require a valid cert so CF proxied domains look healthy
        )
        return 200 <= r.status_code < 400
    except Exception:
        return False


def _tick():
    """One pass over the domains table. Logs nothing on no-change to avoid
    spamming pipeline_log."""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT domain, status, server_id FROM domains "
            "WHERE status IN ('hosted', 'live')"
        ).fetchall()
    finally:
        conn.close()

    # Group by server_id so we can detect whole-server outages after the loop.
    by_server: dict[int, list[dict]] = {}

    # F13: run all HTTPS probes in parallel. Each _check_one is I/O bound so
    # threads are ideal — we bound the pool at _PROBE_MAX_WORKERS to avoid
    # hammering any one CF edge with 60 simultaneous connections.
    row_list = list(rows)
    probe_results: dict[str, bool] = {}
    if row_list:
        with ThreadPoolExecutor(max_workers=_PROBE_MAX_WORKERS) as ex:
            futures = {ex.submit(_check_one, r["domain"]): r["domain"] for r in row_list}
            for fut in as_completed(futures):
                probe_results[futures[fut]] = bool(fut.result()) if not fut.exception() else False

    for r in row_list:
        domain = r["domain"]
        status = r["status"]
        server_id = r["server_id"]
        up = probe_results.get(domain, False)

        if up:
            _streak_up[domain] = _streak_up.get(domain, 0) + 1
            _streak_down[domain] = 0
        else:
            _streak_down[domain] = _streak_down.get(domain, 0) + 1
            _streak_up[domain] = 0

        if server_id:
            by_server.setdefault(server_id, []).append(
                {"domain": domain, "down_streak": _streak_down.get(domain, 0)}
            )

        # hosted -> live: require 2 consecutive wins (avoid CF edge flaps)
        if status == "hosted" and _streak_up.get(domain, 0) >= 2:
            conn = get_db()
            try:
                conn.execute(
                    "UPDATE domains SET status='live', updated_at=datetime('now') "
                    "WHERE domain=?",
                    (domain,),
                )
                conn.commit()
            finally:
                conn.close()
            log_pipeline(domain, "live_check", "completed",
                         "Domain went LIVE (2 consecutive successful HTTPS checks)")

        # live -> hosted: require 3 consecutive failures (outage warning)
        elif status == "live" and _streak_down.get(domain, 0) >= 3:
            conn = get_db()
            try:
                conn.execute(
                    "UPDATE domains SET status='hosted', updated_at=datetime('now') "
                    "WHERE domain=?",
                    (domain,),
                )
                conn.commit()
            finally:
                conn.close()
            log_pipeline(domain, "live_check", "warning",
                         "Domain OFFLINE — 3 consecutive HTTPS failures, "
                         "reverted status to 'hosted'")

    # ---------- Whole-server dead detection ----------
    _check_dead_servers(by_server)


def _check_dead_servers(by_server: dict[int, list[dict]]) -> None:
    """Mark a server 'dead' + optionally auto-migrate its domains when
    every domain on it has been down for `dead_server_threshold_ticks`
    consecutive ticks (default 10 — roughly 10 minutes at 60s ticks).

    Only inspects servers currently in status='ready'. The dead-flip happens
    even when auto-migrate is disabled, so the user sees the detection and
    can hit 'Migrate Now' manually.
    """
    try:
        threshold = int(get_setting("dead_server_threshold_ticks") or 10)
    except (TypeError, ValueError):
        threshold = 10

    auto_migrate = (get_setting("auto_migrate_enabled") or "0") == "1"

    conn = get_db()
    try:
        server_rows = conn.execute(
            "SELECT id, name, ip, status FROM servers WHERE status='ready'"
        ).fetchall()
    finally:
        conn.close()

    for s in server_rows:
        sid = s["id"]
        entries = by_server.get(sid) or []
        if not entries:
            continue  # no domains — not something we can judge as dead
        all_down = all(e["down_streak"] >= threshold for e in entries)
        if not all_down:
            continue

        # Short-circuit: already queued / being migrated — don't re-trigger.
        with _migrating_lock:
            if sid in _migrating:
                continue
            _migrating.add(sid)

        # Flip the server to 'dead' so the UI shows it clearly, and so the
        # next tick skips it (status != 'ready').
        conn = get_db()
        try:
            conn.execute(
                "UPDATE servers SET status='dead' WHERE id=?", (sid,),
            )
            conn.commit()
        finally:
            conn.close()

        worst = max((e["down_streak"] for e in entries), default=0)
        msg = (f"Server #{sid} ({s['name']} / {s['ip']}) marked DEAD — "
               f"all {len(entries)} domains down for {worst}+ ticks "
               f"(threshold={threshold})")
        log_pipeline(f"server-{sid}", "dead_detect", "warning", msg)

        # Fire multi-channel alert (email + Telegram + WhatsApp + SMS — every
        # channel that's configured). Non-blocking: won't delay migration.
        try:
            from modules.notify import notify_server_dead
            notify_server_dead(sid, s["name"] or "", s["ip"] or "",
                               len(entries))
        except Exception as e:
            log_pipeline(f"server-{sid}", "notify", "warning",
                         f"dead-server notify failed: {e}")

        if auto_migrate:
            _spawn_migration(sid)
        else:
            log_pipeline(
                f"server-{sid}", "dead_detect", "warning",
                "Auto-migrate DISABLED — click 'Migrate Now' on the Servers "
                "page to move domains, or enable auto_migrate in Settings."
            )
            # Since we won't be migrating, clear the 'migrating' flag so a
            # manual mark-ready + re-detection can fire the alarm again.
            with _migrating_lock:
                _migrating.discard(sid)


def _spawn_migration(server_id: int) -> None:
    """Run migrate_server in a daemon thread. Removes the server from the
    _migrating set when done (success OR failure) so future dead-detect
    passes aren't permanently blocked.
    """
    def _run():
        from modules.notify import notify_migration_done, notify
        try:
            from modules.migration import migrate_server
            result = migrate_server(server_id)
            log_pipeline(
                f"server-{server_id}", "auto_migrate",
                "completed" if not result["failed"] else "warning",
                f"{result['msg']}  ok={len(result['ok'])} "
                f"failed={len(result['failed'])}",
            )
            try:
                notify_migration_done(
                    server_id, result.get("msg", ""),
                    len(result.get("ok", [])),
                    len(result.get("failed", [])),
                )
            except Exception:
                pass
        except Exception as e:
            log_pipeline(f"server-{server_id}", "auto_migrate", "failed",
                         f"migrate_server raised: {e}")
            try:
                notify(
                    f"Auto-migrate CRASHED: server #{server_id}",
                    f"migrate_server raised {type(e).__name__}: {e}\n\n"
                    f"Domains on this server are likely still offline. "
                    f"Intervene manually from the dashboard.",
                    severity="error",
                )
            except Exception:
                pass
        finally:
            with _migrating_lock:
                _migrating.discard(server_id)

    threading.Thread(target=_run, daemon=True,
                     name=f"auto-migrate-{server_id}").start()


def _loop():
    """Inner loop — single tick + sleep. Wrapped by a supervisor so an
    outer-level exception (not just per-tick) can't silently kill detection.
    """
    while not _stop_event.is_set():
        try:
            _tick()
        except Exception as e:
            # Don't let a bad pass kill the thread
            try:
                log_pipeline("(live-checker)", "live_check", "warning",
                             f"tick error: {e}")
            except Exception:
                pass
        # Sleep in small increments so stop_event is responsive
        try:
            interval = int(get_setting("live_check_interval_s") or 60)
        except (TypeError, ValueError):
            interval = 60
        for _ in range(max(1, interval)):
            if _stop_event.is_set():
                return
            time.sleep(1)


def _supervised_loop():
    """Outer supervisor — restarts _loop() if it dies for any reason.
    Keeps the live-checker alive even through unexpected failures that
    escape the inner try/except (e.g., import errors after hot-reload,
    sudden DB corruption, OS-level resource exhaustion).
    """
    restart_count = 0
    last_restart = 0.0
    while not _stop_event.is_set():
        try:
            _loop()
            # Clean exit from _loop means _stop_event was set — do not restart.
            return
        except Exception as e:
            restart_count += 1
            now = time.time()
            # Back off if we're crash-looping (> 3 restarts in 60s).
            if now - last_restart < 60 and restart_count > 3:
                try:
                    log_pipeline("(live-checker)", "supervisor", "failed",
                                 f"crash-looping ({restart_count} restarts in <60s) — "
                                 f"giving up until stop+start: {e}")
                except Exception:
                    pass
                return
            last_restart = now
            try:
                log_pipeline("(live-checker)", "supervisor", "warning",
                             f"inner loop crashed (restart #{restart_count}): "
                             f"{type(e).__name__}: {e}")
            except Exception:
                pass
            time.sleep(2)


def start():
    """Idempotent: kicks off the live-checker thread if not already running."""
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop_event.clear()
    _thread = threading.Thread(target=_supervised_loop, name="live-checker", daemon=True)
    _thread.start()


def stop():
    """Signal the thread to exit after its current tick."""
    _stop_event.set()


def status():
    with _migrating_lock:
        migrating = sorted(_migrating)
    return {
        "running": bool(_thread and _thread.is_alive()),
        "streak_up": dict(_streak_up),
        "streak_down": dict(_streak_down),
        "migrating_server_ids": migrating,
    }
