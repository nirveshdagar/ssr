import sqlite3
import os
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), "data", "ssr.db")


# ---------------------------------------------------------------------------
# Status taxonomy
# ---------------------------------------------------------------------------
# domain.status was historically a single bucket 'error' that collapsed
# transient API failures (operator can re-run) and operator-config failures
# (operator must change something) into one indistinguishable state. Splitting
# them lets the dashboard surface "retry me" vs "look at me" differently.
#
# Existing granular states stay (cf_pool_full, content_blocked, ns_pending_external).
# Legacy 'error' rows from before the split are treated as retryable for UI
# coloring — operators can still re-run without losing the row.

RETRYABLE_ERROR_STATUSES = frozenset({"retryable_error", "error"})

# Terminal = needs human intervention before a re-run can succeed.
TERMINAL_ERROR_STATUSES = frozenset({"terminal_error", "cf_pool_full",
                                      "content_blocked"})

# Waiting = pipeline paused, awaiting an external event (DNS propagation,
# manual NS change at registrar, registrant info pending). The pipeline
# isn't 'running' or 'failed' — it's blocked on something outside our
# control. Operators get a distinct badge color so 'I need to act' is
# obvious.
WAITING_STATUSES = frozenset({
    "manual_action_required",   # generic human-action gate
    "waiting_dns",              # DNS / NS propagation in flight
    "ns_pending_external",      # legacy: external registrar NS change
})

# Ready = a step finished and the pipeline is positioned to start the
# next phase. These are checkpoints between steps. Useful as both
# pipeline-set states and operator-set overrides.
READY_STATUSES = frozenset({
    "ready_for_ssl",            # zone active, server provisioned — ready for step 8
    "ready_for_content",        # SSL installed — ready for step 9 (LLM)
    "zone_active",              # legacy alias for ready_for_ssl
    "ssl_installed",            # legacy alias for ready_for_content
})


def is_retryable_error(status):
    return status in RETRYABLE_ERROR_STATUSES


def is_terminal_error(status):
    return status in TERMINAL_ERROR_STATUSES


def is_error_status(status):
    return is_retryable_error(status) or is_terminal_error(status)


def is_waiting_status(status):
    return status in WAITING_STATUSES


def is_ready_status(status):
    return status in READY_STATUSES


def get_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    # timeout=10: block up to 10s when another writer holds the lock instead
    # of raising 'database is locked' instantly. With 1 Hz heartbeats from
    # many workers + live_checker + teardowns, contention is rare but real.
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    # Waiting a bit longer at the SQL engine layer too (ms) for belt-and-braces.
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS domains (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        domain          TEXT UNIQUE NOT NULL,
        status          TEXT DEFAULT 'pending',
        cf_email        TEXT,
        cf_global_key   TEXT,
        cf_zone_id      TEXT,
        cf_nameservers  TEXT,
        cf_account_id   TEXT,
        server_id       INTEGER REFERENCES servers(id),
        current_proxy_ip TEXT,
        site_html       TEXT,
        created_at      TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS servers (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT,
        ip              TEXT,
        do_droplet_id   TEXT,
        sa_server_id    TEXT,
        sa_org_id       TEXT,
        status          TEXT DEFAULT 'pending',
        created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS proxy_ips (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ip          TEXT UNIQUE NOT NULL,
        label       TEXT,
        status      TEXT DEFAULT 'active',
        main_server_ip TEXT,
        use_count   INTEGER DEFAULT 0,
        last_used   TEXT,
        created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rotation_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        domain      TEXT NOT NULL,
        old_ip      TEXT,
        new_ip      TEXT NOT NULL,
        rotated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pipeline_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        domain      TEXT NOT NULL,
        step        TEXT NOT NULL,
        status      TEXT DEFAULT 'pending',
        message     TEXT,
        created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS step_tracker (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        domain      TEXT NOT NULL,
        step_num    INTEGER NOT NULL,
        step_name   TEXT NOT NULL,
        status      TEXT DEFAULT 'pending',
        message     TEXT DEFAULT '',
        started_at  TEXT,
        finished_at TEXT,
        UNIQUE(domain, step_num)
    );

    CREATE TABLE IF NOT EXISTS cf_keys (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        email           TEXT NOT NULL UNIQUE,
        api_key         TEXT NOT NULL,
        alias           TEXT,
        cf_account_id   TEXT,
        domains_used    INTEGER NOT NULL DEFAULT 0,
        max_domains     INTEGER NOT NULL DEFAULT 20,
        is_active       INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT DEFAULT (datetime('now')),
        last_used_at    TEXT
    );
    """)

    # --- Idempotent column migrations (SQLite lacks ADD COLUMN IF NOT EXISTS) ---
    def _col_exists(table, col):
        return any(r[1] == col for r in conn.execute(f"PRAGMA table_info({table})").fetchall())

    # domains.cf_key_id — FK to cf_keys(id); identifies which pool key was used
    if not _col_exists("domains", "cf_key_id"):
        conn.execute("ALTER TABLE domains ADD COLUMN cf_key_id INTEGER REFERENCES cf_keys(id)")

    # servers.sites_count — current number of domains hosted on this server
    if not _col_exists("servers", "sites_count"):
        conn.execute("ALTER TABLE servers ADD COLUMN sites_count INTEGER NOT NULL DEFAULT 0")

    # servers.max_sites — configurable ceiling (default 60 per our spec)
    if not _col_exists("servers", "max_sites"):
        conn.execute("ALTER TABLE servers ADD COLUMN max_sites INTEGER NOT NULL DEFAULT 60")

    # servers.region — DO region the droplet was provisioned in
    if not _col_exists("servers", "region"):
        conn.execute("ALTER TABLE servers ADD COLUMN region TEXT")

    # servers.size_slug — DO droplet slug (for reference / audits)
    if not _col_exists("servers", "size_slug"):
        conn.execute("ALTER TABLE servers ADD COLUMN size_slug TEXT")

    # domains.last_heartbeat_at — pipeline-worker heartbeat (written every
    # ~1s during a pipeline run so the watcher UI can prove the worker is
    # still alive even during long blocking operations like SA agent install)
    if not _col_exists("domains", "last_heartbeat_at"):
        conn.execute("ALTER TABLE domains ADD COLUMN last_heartbeat_at TEXT")

    # Phase B+ migration support: cache everything a dead-server migration
    # needs so it can complete in ~60s per domain instead of re-running the
    # full pipeline. See modules/migration.py for the migrator.
    if not _col_exists("domains", "cf_a_record_id"):
        conn.execute("ALTER TABLE domains ADD COLUMN cf_a_record_id TEXT")
    if not _col_exists("domains", "cf_www_record_id"):
        conn.execute("ALTER TABLE domains ADD COLUMN cf_www_record_id TEXT")
    if not _col_exists("domains", "origin_cert_pem"):
        conn.execute("ALTER TABLE domains ADD COLUMN origin_cert_pem TEXT")
    if not _col_exists("domains", "origin_key_pem"):
        conn.execute("ALTER TABLE domains ADD COLUMN origin_key_pem TEXT")
    if not _col_exists("domains", "content_archive_path"):
        conn.execute("ALTER TABLE domains ADD COLUMN content_archive_path TEXT")

    # Pipeline cancel flag (issue #5): set by the /cancel route, checked at
    # every step boundary in the worker. Values: NULL / 0 / 1.
    if not _col_exists("domains", "cancel_requested"):
        conn.execute("ALTER TABLE domains ADD COLUMN cancel_requested INTEGER DEFAULT 0")

    # Audit log (issue #9): who did what, when.
    conn.execute("""
    CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at  TEXT DEFAULT (datetime('now')),
        actor_ip    TEXT,
        action      TEXT NOT NULL,
        target      TEXT,
        detail      TEXT
    );
    """)

    # Durable job queue. Replaces the daemon-thread spawns scattered through
    # app.py and pipeline.py — long-running work (pipelines, server creation,
    # full-domain teardown) goes here so a Flask restart doesn't kill it
    # mid-step. See modules/jobs.py.
    conn.execute("""
    CREATE TABLE IF NOT EXISTS jobs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        kind          TEXT NOT NULL,
        payload_json  TEXT NOT NULL,
        status        TEXT NOT NULL,            -- queued | running | done | failed | canceled
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 1,
        locked_by     TEXT,
        locked_at     REAL,
        last_error    TEXT,
        created_at    REAL NOT NULL,
        updated_at    REAL NOT NULL
    );
    """)

    # Per-run pipeline state. step_tracker stores ONLY the latest attempt per
    # (domain, step) — we lose history on rerun. pipeline_runs + pipeline_step_runs
    # retain the full history across runs so an operator can look at "this
    # domain has been re-run 3 times; here's what each attempt did".
    # artifact_json is reserved for future per-step artifact storage (cert PEM,
    # generated PHP, CF zone id, etc.) — currently nullable, not yet wired.
    conn.execute("""
    CREATE TABLE IF NOT EXISTS pipeline_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        domain        TEXT NOT NULL,
        job_id        INTEGER,                  -- jobs.id when triggered via queue
        status        TEXT NOT NULL,            -- running | completed | failed | canceled
        params_json   TEXT,
        started_at    REAL NOT NULL,
        ended_at      REAL,
        error         TEXT
    );
    """)
    conn.execute("""
    CREATE TABLE IF NOT EXISTS pipeline_step_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id        INTEGER NOT NULL,
        step_num      INTEGER NOT NULL,
        status        TEXT NOT NULL,
        attempt       INTEGER NOT NULL DEFAULT 1,
        started_at    REAL,
        ended_at      REAL,
        message       TEXT,
        artifact_json TEXT,
        error         TEXT,
        FOREIGN KEY (run_id) REFERENCES pipeline_runs(id)
    );
    """)

    # --- Indexes (issue #1) ---
    # Hot queries: pipeline_log by domain / by created_at DESC; step_tracker
    # lookups per-domain; domains by server_id / status. Without these, the
    # watcher UI and log pages hit full-table scans once row counts grow.
    conn.executescript("""
    CREATE INDEX IF NOT EXISTS idx_pipeline_log_domain      ON pipeline_log(domain);
    CREATE INDEX IF NOT EXISTS idx_pipeline_log_created_at  ON pipeline_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_step_tracker_domain      ON step_tracker(domain);
    CREATE INDEX IF NOT EXISTS idx_domains_server_id        ON domains(server_id);
    CREATE INDEX IF NOT EXISTS idx_domains_status           ON domains(status);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at     ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_status_created      ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_domain     ON pipeline_runs(domain, id DESC);
    CREATE INDEX IF NOT EXISTS idx_pipeline_step_runs_run   ON pipeline_step_runs(run_id);
    """)

    conn.commit()
    conn.close()


# --------------- Settings helpers ---------------

def get_setting(key, default=None):
    conn = get_db()
    try:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    finally:
        conn.close()
    if not row:
        return default
    val = row["value"]
    # Transparent decryption for sensitive keys. Legacy plaintext is
    # returned as-is (is_sensitive pattern-match, but decrypt() is a no-op
    # for non-encrypted strings thanks to the marker check).
    try:
        from modules.secrets_vault import is_sensitive, decrypt
        if val and is_sensitive(key):
            return decrypt(val)
    except Exception:
        pass
    return val


def set_setting(key, value):
    # Encrypt sensitive settings at the boundary. get_setting() decrypts
    # transparently. Non-secret settings write through unchanged.
    to_store = value
    try:
        from modules.secrets_vault import is_sensitive, encrypt
        if value and is_sensitive(key):
            to_store = encrypt(value)
    except Exception:
        pass  # encryption is best-effort — don't break settings save if Fernet breaks
    conn = get_db()
    try:
        conn.execute("""
            INSERT INTO settings(key, value, updated_at) VALUES(?,?,datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
        """, (key, to_store))
        conn.commit()
    finally:
        conn.close()


def get_all_settings():
    conn = get_db()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    out = {r["key"]: r["value"] for r in rows}
    # Transparent decrypt for sensitive keys — so the settings template
    # can render password inputs without showing enc:v1:... gibberish.
    try:
        from modules.secrets_vault import is_sensitive, decrypt
        for k, v in list(out.items()):
            if v and is_sensitive(k):
                out[k] = decrypt(v)
    except Exception:
        pass
    return out


# --------------- Domain helpers ---------------

def add_domain(domain):
    conn = get_db()
    try:
        conn.execute("INSERT INTO domains(domain) VALUES(?)", (domain,))
        conn.commit()
    except sqlite3.IntegrityError:
        pass
    conn.close()


def get_domains():
    conn = get_db()
    rows = conn.execute("SELECT * FROM domains ORDER BY created_at DESC").fetchall()
    conn.close()
    return rows


def audit(action: str, target: str = "", detail: str = "",
          actor_ip: str = "") -> None:
    """Append an audit-log row. Fire-and-forget — never raises.

    `action` is a short tag like 'login_ok' / 'server_delete' / 'settings_save'.
    `target` is the thing acted on (domain, server_id, setting key).
    `detail` is free-form context.
    `actor_ip` is the requester's remote addr (pass request.remote_addr).
    """
    try:
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO audit_log(actor_ip, action, target, detail) "
                "VALUES (?,?,?,?)",
                (actor_ip or "", action, target, (detail or "")[:1000]),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass  # never let an audit-log failure block the real action


def get_audit_log(limit: int = 200) -> list:
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


def heartbeat(domain):
    """Touch last_heartbeat_at on a domain row — called by pipeline workers
    ~every second to prove they're still alive. Uses a short-lived connection
    so concurrent readers aren't blocked.
    """
    conn = get_db()
    try:
        conn.execute(
            "UPDATE domains SET last_heartbeat_at = datetime('now') WHERE domain = ?",
            (domain,),
        )
        conn.commit()
    finally:
        conn.close()


def get_domain(domain):
    conn = get_db()
    row = conn.execute("SELECT * FROM domains WHERE domain=?", (domain,)).fetchone()
    conn.close()
    return row


# Whitelist of allowed column names for safe dynamic SQL
_DOMAIN_COLS = {"status", "cf_email", "cf_global_key", "cf_zone_id", "cf_nameservers",
                "cf_account_id", "server_id", "current_proxy_ip", "site_html",
                "cf_a_record_id", "cf_www_record_id",
                "origin_cert_pem", "origin_key_pem", "content_archive_path",
                "cancel_requested"}
_SERVER_COLS = {"name", "ip", "do_droplet_id", "sa_server_id", "sa_org_id", "status"}
_PROXY_COLS = {"label", "status", "main_server_ip", "use_count", "last_used"}


def _safe_update(table, where_col, where_val, allowed_cols, **kwargs):
    """Build a safe UPDATE query with column whitelist to prevent SQL injection."""
    safe = {k: v for k, v in kwargs.items() if k in allowed_cols}
    if not safe:
        return
    sets = ", ".join(f"{k}=?" for k in safe)
    vals = list(safe.values()) + [where_val]
    conn = get_db()
    try:
        extra = ", updated_at=datetime('now')" if table == "domains" else ""
        conn.execute(f"UPDATE {table} SET {sets}{extra} WHERE {where_col}=?", vals)
        conn.commit()
    finally:
        conn.close()


def update_domain(domain, **kwargs):
    _safe_update("domains", "domain", domain, _DOMAIN_COLS, **kwargs)


def delete_domain(domain):
    conn = get_db()
    conn.execute("DELETE FROM domains WHERE domain=?", (domain,))
    conn.commit()
    conn.close()


# --------------- Server helpers ---------------

def add_server(name, ip, do_droplet_id=None):
    conn = get_db()
    conn.execute("INSERT INTO servers(name,ip,do_droplet_id,status) VALUES(?,?,?,'creating')",
                 (name, ip, do_droplet_id))
    conn.commit()
    sid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    return sid


def get_servers():
    """Return every server, with `sites_count` COMPUTED on the fly from
    the actual number of domains assigned to each server.

    Computing rather than storing eliminates drift from bump/unbump races
    (pipeline re-runs, migration retries) that could otherwise let a 60-cap
    server show 61/60 after enough retries. sites_count is now a function,
    not a counter.
    """
    conn = get_db()
    rows = conn.execute("""
        SELECT s.*,
               (SELECT COUNT(*) FROM domains d WHERE d.server_id = s.id)
                   AS _live_sites_count
          FROM servers s
         ORDER BY s.created_at DESC
    """).fetchall()
    conn.close()
    # Overlay the computed count onto the returned rows. sqlite3.Row is
    # read-only, so we return a list of dicts instead — callers already
    # treat results as dicts via `dict(row)` where mutation is needed.
    out = []
    for r in rows:
        d = dict(r)
        d["sites_count"] = d.pop("_live_sites_count")
        out.append(d)
    return out


def update_server(server_id, **kwargs):
    _safe_update("servers", "id", server_id, _SERVER_COLS, **kwargs)


# --------------- Proxy IP helpers ---------------

def add_proxy_ip(ip, label="", main_server_ip=""):
    conn = get_db()
    try:
        conn.execute("INSERT INTO proxy_ips(ip,label,main_server_ip) VALUES(?,?,?)",
                     (ip, label, main_server_ip))
        conn.commit()
    except sqlite3.IntegrityError:
        pass
    conn.close()


def get_proxy_ips(status="active"):
    conn = get_db()
    if status:
        rows = conn.execute("SELECT * FROM proxy_ips WHERE status=? ORDER BY use_count ASC, last_used ASC", (status,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM proxy_ips ORDER BY created_at DESC").fetchall()
    conn.close()
    return rows


def update_proxy_ip(ip, **kwargs):
    _safe_update("proxy_ips", "ip", ip, _PROXY_COLS, **kwargs)


def mark_proxy_used(ip):
    conn = get_db()
    conn.execute("UPDATE proxy_ips SET use_count=use_count+1, last_used=datetime('now') WHERE ip=?", (ip,))
    conn.commit()
    conn.close()


# --------------- Rotation log ---------------

def log_rotation(domain, old_ip, new_ip):
    conn = get_db()
    conn.execute("INSERT INTO rotation_log(domain,old_ip,new_ip) VALUES(?,?,?)",
                 (domain, old_ip, new_ip))
    conn.commit()
    conn.close()


def get_rotation_logs(limit=100):
    conn = get_db()
    rows = conn.execute("SELECT * FROM rotation_log ORDER BY rotated_at DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return rows


# --------------- Pipeline log ---------------

def log_pipeline(domain, step, status, message=""):
    conn = get_db()
    conn.execute("INSERT INTO pipeline_log(domain,step,status,message) VALUES(?,?,?,?)",
                 (domain, step, status, message))
    conn.commit()
    conn.close()


def get_pipeline_logs(domain=None, limit=200):
    conn = get_db()
    if domain:
        rows = conn.execute("SELECT * FROM pipeline_log WHERE domain=? ORDER BY created_at DESC LIMIT ?",
                            (domain, limit)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM pipeline_log ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return rows


# --------------- Step tracker (watcher) ---------------

PIPELINE_STEPS = {
    1:  "Buy / Detect Domain",
    2:  "Assign Cloudflare Key",
    3:  "Create Zone in Cloudflare",
    4:  "Set Nameservers",
    5:  "Wait for Zone Active",
    6:  "Pick / Provision Server",
    7:  "Create Site on ServerAvatar",
    8:  "Issue & Install Origin SSL",
    9:  "Generate Site Content (LLM)",
    10: "Upload index.php",
}


def init_steps(domain):
    """Initialize all 7 pipeline steps for a domain (reset watcher)."""
    conn = get_db()
    for num, name in PIPELINE_STEPS.items():
        conn.execute("""
            INSERT INTO step_tracker(domain, step_num, step_name, status, message)
            VALUES(?,?,?,'pending','')
            ON CONFLICT(domain, step_num)
            DO UPDATE SET status='pending', message='', started_at=NULL, finished_at=NULL
        """, (domain, num, name))
    conn.commit()
    conn.close()


def update_step(domain, step_num, status, message=""):
    """
    Update a step's status for the watcher.
    status: pending, running, completed, failed, skipped, warning

    Writes go to step_tracker (legacy: latest-attempt-only, used by current
    watcher UI) AND mirror into pipeline_step_runs scoped to the active
    pipeline_runs row for this domain (if any) so the new tables retain
    full history across reruns. If no pipeline_runs row is in 'running'
    state for this domain, only step_tracker is touched.
    """
    import time as _time
    conn = get_db()
    now = datetime.now().isoformat(timespec="seconds")
    if status == "running":
        conn.execute("""
            UPDATE step_tracker SET status=?, message=?, started_at=?
            WHERE domain=? AND step_num=?
        """, (status, message, now, domain, step_num))
    elif status in ("completed", "failed", "skipped", "warning"):
        conn.execute("""
            UPDATE step_tracker SET status=?, message=?, finished_at=?
            WHERE domain=? AND step_num=?
        """, (status, message, now, domain, step_num))
    else:
        conn.execute("""
            UPDATE step_tracker SET status=?, message=?
            WHERE domain=? AND step_num=?
        """, (status, message, domain, step_num))

    run_row = conn.execute(
        """SELECT id FROM pipeline_runs
            WHERE domain = ? AND status = 'running'
            ORDER BY id DESC LIMIT 1""",
        (domain,)
    ).fetchone()
    if run_row:
        run_id = run_row["id"]
        now_real = _time.time()
        is_terminal = status in ("completed", "failed", "skipped", "warning")
        existing = conn.execute(
            "SELECT id FROM pipeline_step_runs WHERE run_id=? AND step_num=?",
            (run_id, step_num)
        ).fetchone()
        if existing is None:
            conn.execute(
                """INSERT INTO pipeline_step_runs
                     (run_id, step_num, status, attempt, started_at, ended_at, message)
                   VALUES (?, ?, ?, 1, ?, ?, ?)""",
                (run_id, step_num, status,
                 now_real if status == "running" else None,
                 now_real if is_terminal else None,
                 message)
            )
        else:
            # Preserve started_at and ended_at once they're set so the first
            # transition timestamps stick across re-updates within the same run.
            conn.execute(
                """UPDATE pipeline_step_runs
                      SET status = ?,
                          message = ?,
                          started_at = COALESCE(started_at,
                              CASE WHEN ? = 'running' THEN ? END),
                          ended_at = COALESCE(ended_at,
                              CASE WHEN ? THEN ? END)
                    WHERE id = ?""",
                (status, message, status, now_real,
                 1 if is_terminal else 0, now_real, existing["id"])
            )
    conn.commit()
    conn.close()


def start_pipeline_run(domain, params=None, job_id=None):
    """Insert a 'running' pipeline_runs row. Returns the new run id."""
    import json as _json, time as _time
    conn = get_db()
    try:
        cur = conn.execute(
            """INSERT INTO pipeline_runs
                 (domain, job_id, status, params_json, started_at)
               VALUES (?, ?, 'running', ?, ?)""",
            (domain, job_id,
             _json.dumps(params) if params else None,
             _time.time())
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def end_pipeline_run(run_id, status, error=None):
    """Mark a pipeline_runs row ended. status: completed | failed | canceled."""
    import time as _time
    conn = get_db()
    try:
        conn.execute(
            """UPDATE pipeline_runs
                  SET status = ?, error = ?, ended_at = ?
                WHERE id = ?""",
            (status, error, _time.time(), run_id),
        )
        conn.commit()
    finally:
        conn.close()


def list_pipeline_runs(domain, limit=20):
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM pipeline_runs WHERE domain = ? ORDER BY id DESC LIMIT ?",
            (domain, limit)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_pipeline_run(run_id):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT * FROM pipeline_runs WHERE id = ?", (run_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_step_runs(run_id):
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT * FROM pipeline_step_runs
                WHERE run_id = ?
                ORDER BY step_num, attempt""",
            (run_id,)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def set_step_artifact(domain, step_num, artifact):
    """Merge `artifact` (dict, JSON-serializable) into the
    pipeline_step_runs.artifact_json field for the matching
    (active run, step_num) row.

    No-op if there's no running pipeline_runs for the domain. The merge
    is shallow — top-level keys in `artifact` overwrite existing keys on
    the row, other keys are preserved.

    Use this from step success paths to persist audit metadata about
    what the step produced (zone_id, server_id, content sha256, etc.).
    The full bytes (PHP, cert PEM) still live in the domain row /
    archive file — artifact_json holds references and metadata for the
    history trail.
    """
    import json as _json
    conn = get_db()
    try:
        run_row = conn.execute(
            """SELECT id FROM pipeline_runs
                WHERE domain = ? AND status = 'running'
                ORDER BY id DESC LIMIT 1""",
            (domain,)
        ).fetchone()
        if not run_row:
            return
        step_row = conn.execute(
            """SELECT id, artifact_json FROM pipeline_step_runs
                WHERE run_id = ? AND step_num = ?""",
            (run_row["id"], step_num)
        ).fetchone()
        if not step_row:
            return
        merged = {}
        if step_row["artifact_json"]:
            try:
                merged = _json.loads(step_row["artifact_json"]) or {}
            except (ValueError, TypeError):
                merged = {}
        merged.update(artifact)
        conn.execute(
            "UPDATE pipeline_step_runs SET artifact_json = ? WHERE id = ?",
            (_json.dumps(merged), step_row["id"])
        )
        conn.commit()
    finally:
        conn.close()


def get_steps(domain):
    """Get all step statuses for a domain (for watcher display)."""
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM step_tracker WHERE domain=? ORDER BY step_num ASC",
        (domain,)
    ).fetchall()
    conn.close()
    return rows


def get_all_active_watchers():
    """Get domains that have at least one step 'running'."""
    conn = get_db()
    rows = conn.execute("""
        SELECT DISTINCT domain FROM step_tracker WHERE status='running'
    """).fetchall()
    conn.close()
    return [r["domain"] for r in rows]


def get_watcher_summary():
    """Get step tracker data for ALL domains that have tracker entries."""
    conn = get_db()
    rows = conn.execute("""
        SELECT domain, step_num, step_name, status, message, started_at, finished_at
        FROM step_tracker ORDER BY domain, step_num
    """).fetchall()
    conn.close()
    # Group by domain
    result = {}
    for r in rows:
        d = r["domain"]
        if d not in result:
            result[d] = []
        result[d].append(dict(r))
    return result


if __name__ == "__main__":
    init_db()
    print(f"Database initialized at {DB_PATH}")
