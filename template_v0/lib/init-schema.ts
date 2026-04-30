/**
 * SQLite schema bootstrap. Runs once per DB connection (right after the
 * PRAGMAs in lib/db.ts:getDb()) and creates every table + index this app
 * needs. All statements are idempotent — `CREATE TABLE IF NOT EXISTS`
 * plus a `tryAlter()` helper that swallows the "duplicate column" error
 * SQLite raises when an ALTER TABLE runs against an already-migrated row
 * (SQLite has no `IF NOT EXISTS` for column adds).
 *
 * History: the schema used to be owned by the Flask side's database.py
 * `init_db()`. With the Flask app removed, the Next.js port owns
 * end-to-end DB lifecycle. A wiped `data/ssr.db` is now safe — first
 * connection rebuilds the schema; encrypted columns survive as long as
 * `data/.ssr_secret_fernet` is preserved.
 */

import type { DatabaseSync } from "node:sqlite"

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS servers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT,
    ip              TEXT,
    do_droplet_id   TEXT,
    sa_server_id    TEXT,
    sa_org_id       TEXT,
    status          TEXT DEFAULT 'pending',
    sites_count     INTEGER NOT NULL DEFAULT 0,
    max_sites       INTEGER NOT NULL DEFAULT 60,
    region          TEXT,
    size_slug       TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS domains (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    domain                TEXT UNIQUE NOT NULL,
    status                TEXT DEFAULT 'pending',
    cf_email              TEXT,
    cf_global_key         TEXT,
    cf_zone_id            TEXT,
    cf_nameservers        TEXT,
    cf_account_id         TEXT,
    cf_key_id             INTEGER REFERENCES cf_keys(id),
    server_id             INTEGER REFERENCES servers(id),
    current_proxy_ip      TEXT,
    site_html             TEXT,
    cf_a_record_id        TEXT,
    cf_www_record_id      TEXT,
    origin_cert_pem       TEXT,
    origin_key_pem        TEXT,
    content_archive_path  TEXT,
    cancel_requested      INTEGER DEFAULT 0,
    last_heartbeat_at     TEXT,
    created_at            TEXT DEFAULT (datetime('now')),
    updated_at            TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS proxy_ips (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ip              TEXT UNIQUE NOT NULL,
    label           TEXT,
    status          TEXT DEFAULT 'active',
    main_server_ip  TEXT,
    use_count       INTEGER DEFAULT 0,
    last_used       TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
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

  CREATE TABLE IF NOT EXISTS cf_workers_ai_keys (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT NOT NULL,
    api_token       TEXT NOT NULL,
    alias           TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,
    calls_today     INTEGER NOT NULL DEFAULT 0,
    calls_total     INTEGER NOT NULL DEFAULT 0,
    last_call_at    TEXT,
    last_call_date  TEXT,
    last_error      TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(account_id, api_token)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT DEFAULT (datetime('now')),
    actor_ip    TEXT,
    action      TEXT NOT NULL,
    target      TEXT,
    detail      TEXT
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    status        TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts  INTEGER NOT NULL DEFAULT 1,
    locked_by     TEXT,
    locked_at     REAL,
    last_error    TEXT,
    created_at    REAL NOT NULL,
    updated_at    REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pipeline_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    domain        TEXT NOT NULL,
    job_id        INTEGER,
    status        TEXT NOT NULL,
    params_json   TEXT,
    started_at    REAL NOT NULL,
    ended_at      REAL,
    error         TEXT
  );

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
`

const CREATE_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_pipeline_log_domain        ON pipeline_log(domain);
  CREATE INDEX IF NOT EXISTS idx_pipeline_log_created_at    ON pipeline_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pipeline_log_domain_id     ON pipeline_log(domain, id DESC);
  CREATE INDEX IF NOT EXISTS idx_step_tracker_domain        ON step_tracker(domain);
  CREATE INDEX IF NOT EXISTS idx_domains_server_id          ON domains(server_id);
  CREATE INDEX IF NOT EXISTS idx_domains_status             ON domains(status);
  CREATE INDEX IF NOT EXISTS idx_audit_log_created_at       ON audit_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_action_id            ON audit_log(action, id DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_status_created        ON jobs(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_pipeline_runs_domain       ON pipeline_runs(domain, id DESC);
  CREATE INDEX IF NOT EXISTS idx_pipeline_step_runs_run     ON pipeline_step_runs(run_id);
`

/**
 * Idempotent ALTER TABLE wrapper. SQLite has no `ADD COLUMN IF NOT EXISTS`,
 * so we attempt the ALTER and swallow the "duplicate column name" error.
 * Other errors (typo in SQL, bad type) propagate as normal.
 */
function tryAlter(db: DatabaseSync, sql: string): void {
  try {
    db.exec(sql)
  } catch (e) {
    const msg = (e as Error).message.toLowerCase()
    if (msg.includes("duplicate column")) return
    throw e
  }
}

/**
 * One-shot migrations for legacy databases that pre-date a column. Safe to
 * leave in place forever — the tryAlter swallows the dup-column error after
 * the first run.
 */
function applyMigrations(db: DatabaseSync): void {
  // Legacy DBs created before these columns landed still need them. New
  // installs hit the CREATE TABLE statements above which already include
  // them, so these are no-ops there.
  tryAlter(db, "ALTER TABLE domains ADD COLUMN cf_key_id INTEGER REFERENCES cf_keys(id)")
  tryAlter(db, "ALTER TABLE domains ADD COLUMN cf_account_id TEXT")
  tryAlter(db, "ALTER TABLE domains ADD COLUMN last_heartbeat_at TEXT")
  tryAlter(db, "ALTER TABLE domains ADD COLUMN cf_a_record_id TEXT")
  tryAlter(db, "ALTER TABLE domains ADD COLUMN cf_www_record_id TEXT")
  tryAlter(db, "ALTER TABLE domains ADD COLUMN origin_cert_pem TEXT")
  tryAlter(db, "ALTER TABLE domains ADD COLUMN origin_key_pem TEXT")
  tryAlter(db, "ALTER TABLE domains ADD COLUMN content_archive_path TEXT")
  tryAlter(db, "ALTER TABLE domains ADD COLUMN cancel_requested INTEGER DEFAULT 0")
  tryAlter(db, "ALTER TABLE servers ADD COLUMN sites_count INTEGER NOT NULL DEFAULT 0")
  tryAlter(db, "ALTER TABLE servers ADD COLUMN max_sites INTEGER NOT NULL DEFAULT 60")
  tryAlter(db, "ALTER TABLE servers ADD COLUMN region TEXT")
  tryAlter(db, "ALTER TABLE servers ADD COLUMN size_slug TEXT")
  // SSL origin-cert verification cache. Updated by:
  //   - migration.ts:migrateDomain after each successful install
  //   - auto-heal.ts:checkOriginCerts every 5 min for hosted/live domains
  //   - pipeline.ts step 8 after issuing the cert
  // Values:
  //   ssl_origin_ok: 1 = CF Origin Cert verified on origin, 0 = wrong cert,
  //                  NULL = never verified (just installed / probe failed)
  //   ssl_last_verified_at: ISO timestamp of last probe
  tryAlter(db, "ALTER TABLE domains ADD COLUMN ssl_origin_ok INTEGER")
  tryAlter(db, "ALTER TABLE domains ADD COLUMN ssl_last_verified_at TEXT")
  // Live-checker per-row state. Updated every tick by live-checker.ts and
  // on-demand by /api/domains/{d}/check-live-now. Surfaces in the /domains
  // "Live" column so the operator can see WHY a domain is down without
  // tailing the live-checker log.
  // Values:
  //   live_ok: 1 = HTTPS probe returned 2xx/3xx, 0 = failure, NULL = never probed
  //   live_reason: short token — "ok", "timeout", "dns_fail",
  //                "connect_refused", "ssl_error", "http_4xx", "http_5xx"
  //   live_http_status: HTTP code if the probe got a response, else NULL
  //   live_checked_at: ISO timestamp of last probe
  tryAlter(db, "ALTER TABLE domains ADD COLUMN live_ok INTEGER")
  tryAlter(db, "ALTER TABLE domains ADD COLUMN live_reason TEXT")
  tryAlter(db, "ALTER TABLE domains ADD COLUMN live_http_status INTEGER")
  tryAlter(db, "ALTER TABLE domains ADD COLUMN live_checked_at TEXT")
}

/**
 * Run all CREATE TABLE / CREATE INDEX / ALTER TABLE statements. Called
 * once per DB connection (cached on globalThis from db.ts:getDb()).
 */
export function initSchema(db: DatabaseSync): void {
  db.exec(CREATE_TABLES)
  applyMigrations(db)
  db.exec(CREATE_INDEXES)
}
