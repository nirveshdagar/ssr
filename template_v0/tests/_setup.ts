/**
 * Test fixture setup — creates a temp DB file, initializes the schema (mirrors
 * Flask's database.init_db), and exposes helpers for tests to call. Each
 * test file should call `setupTestDb()` once and `cleanupTestDb()` after.
 */
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 10000;

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
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    domain          TEXT UNIQUE NOT NULL,
    status          TEXT DEFAULT 'pending',
    cf_email        TEXT,
    cf_global_key   TEXT,
    cf_zone_id      TEXT,
    cf_nameservers  TEXT,
    cf_account_id   TEXT,
    cf_key_id       INTEGER REFERENCES cf_keys(id),
    server_id       INTEGER REFERENCES servers(id),
    current_proxy_ip TEXT,
    site_html       TEXT,
    cf_a_record_id  TEXT,
    cf_www_record_id TEXT,
    origin_cert_pem TEXT,
    origin_key_pem  TEXT,
    content_archive_path TEXT,
    cancel_requested INTEGER DEFAULT 0,
    last_heartbeat_at TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
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

CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_domain ON pipeline_runs(domain, id DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_step_runs_run ON pipeline_step_runs(run_id);
`

let activeDir: string | null = null

export function setupTestDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ssr-test-"))
  const dbPath = path.join(dir, "test.db")
  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA_SQL)
  db.close()
  process.env.SSR_DB_PATH = dbPath
  process.env.SSR_FERNET_KEY_PATH = path.join(dir, ".fernet")
  activeDir = dir
  // Reset module-level singletons
  delete (globalThis as Record<string, unknown>).__ssrDb
  delete (globalThis as Record<string, unknown>).__ssrInflightDomains
  delete (globalThis as Record<string, unknown>).__ssrDropletCreations
  return dbPath
}

export function cleanupTestDb(): void {
  if (activeDir) {
    try { rmSync(activeDir, { recursive: true, force: true }) } catch { /* ignore */ }
    activeDir = null
  }
  delete (globalThis as Record<string, unknown>).__ssrDb
  delete (globalThis as Record<string, unknown>).__ssrInflightDomains
  delete (globalThis as Record<string, unknown>).__ssrDropletCreations
}
