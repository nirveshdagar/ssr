# SSR Dashboard — Next.js deployment

This is the Next.js port of the SSR dashboard. It reads/writes the same
`data/ssr.db` SQLite database the Flask app uses, so both can run side by
side during a migration. For a clean Node-only deploy, the Flask process is
not required.

## Prereqs

- **Node 22+** (we depend on `node:sqlite`, which arrived in 22.5).
- **`patchright`'s Chromium binary** if you plan to use the SA UI-automation
  fallback path: run `npx patchright install chromium` after `npm ci`.
- **OpenSSL** (or any tool that can generate base64 random bytes) for the
  iron-session secret.

## Install + build

```sh
cd template_v0
npm ci
cp .env.example .env.local
# Edit .env.local: set SSR_SESSION_PASSWORD to a fresh base64 secret.
npx patchright install chromium      # only if SA UI fallback is needed
npm run build
```

`npm run build` compiles to `.next/` and validates every route + page. If
this fails, the deploy fails — don't `next start` over a broken build.

## Run

```sh
npm run start              # serves .next/ on port 3000
```

For production, put it behind a process manager (`systemd`, `pm2`, etc.)
that restarts on crash and captures stdout/stderr.

## systemd unit

Drop into `/etc/systemd/system/ssr-dashboard.service`:

```ini
[Unit]
Description=SSR Dashboard (Next.js)
After=network.target

[Service]
Type=simple
User=ssr
Group=ssr
WorkingDirectory=/opt/ssr/template_v0
EnvironmentFile=/opt/ssr/template_v0/.env.local
# Bound the in-process job pool so `next start` workers don't multiply
# beyond what the database can serialize. Default 4 is fine for ~60 domains.
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/node /opt/ssr/template_v0/node_modules/next/dist/bin/next start -p 3000
Restart=on-failure
RestartSec=5
# Don't kill long-running pipeline jobs on graceful stop — give them 5min to
# wrap up; jobs.ts will recover any orphans on restart anyway.
TimeoutStopSec=300
KillMode=mixed

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now ssr-dashboard
sudo journalctl -u ssr-dashboard -f
```

## Health check

Two endpoints are exposed for uptime monitors:

- `GET /healthz` — **unauthenticated**, returns 200 if Node + DB reachable.
  Use this for load balancers and external monitors.
- `GET /api/health` — **authenticated**, same shape but gated.

## Reverse proxy / TLS

The app speaks plain HTTP on 3000. Front it with nginx / Caddy / cloudflared
for TLS. Example nginx fragment:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    # Strip client-supplied XFF first, then set our own. Without the
    # underscore-prefixed empty assignment, an attacker can forge the IP
    # the throttle keys on (if SSR_TRUST_PROXY=1) and the audit log
    # records.
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 600;     # long-poll heartbeats can hold ~5s
    proxy_send_timeout 600;
}
location = /healthz {
    proxy_pass http://127.0.0.1:3000;
    access_log off;
}
```

Set `SSR_TRUST_PROXY=1` in `.env.local` ONCE you've confirmed the proxy
strips client-supplied X-Forwarded-For (the nginx fragment above does this
implicitly because `proxy_set_header` replaces, not appends). Without that
flag the login throttle falls back to a single shared bucket and audit-log
actor IPs are recorded as null — both safer than blindly trusting forged
headers.

## Operating side-by-side with Flask

Both apps speak the same `data/ssr.db`. To avoid double-pickup:

| Worker | Flask | Node |
|---|---|---|
| Job queue (`jobs` table) | always on | `SSR_JOB_WORKERS=0` to mute (or coerced to 1) |
| Live-checker | always on | `SSR_LIVE_CHECKER=1` to enable; off by default |
| Boot recovery (grey-cloud, orphan sweep) | always on | always on (instrumentation.ts) |

Pick one side to own each. The recommended cutover is: run Flask exclusively,
verify Node responds correctly behind the proxy, then flip `SSR_JOB_WORKERS`
on Node and `0` on Flask, then `SSR_LIVE_CHECKER=1` on Node, then stop Flask.

## Logs

Worker output, pipeline events, and request logs all go to stdout. systemd
journal captures them. Pipeline-level events also land in the SQLite
`pipeline_log` table and are visible at `/logs` in the dashboard.

## Backups

`lib/backup.ts` runs a daily VACUUM INTO of `data/ssr.db` plus a copy of
`.ssr_secret_fernet` to `data/backups/`, with 7-day rotation. First run
fires 60s after boot, then every 24h. Override window with
`SSR_BACKUP_KEEP_DAYS=14`; set the dir with `SSR_BACKUP_DIR=/path`; disable
with `SSR_BACKUPS=0`.

For off-host durability, copy `data/backups/` to S3 / restic / borg / etc.
on whatever cadence you trust — the local rotation only protects against
software corruption, not host loss.

If the Fernet key file is ever lost, **the dashboard refuses to auto-
generate a fresh one in production** when encrypted rows exist (would
silently invalidate every secret). Restore from backup or delete the
`enc:v1:`-prefixed rows explicitly.

## Log retention

`lib/log-retention.ts` runs daily and trims:

| Table | Default | Override env |
|---|---|---|
| `pipeline_log` | 30 days | `SSR_RETAIN_PIPELINE_LOG_DAYS` |
| `audit_log` | 90 days | `SSR_RETAIN_AUDIT_DAYS` |
| `pipeline_runs` (+ step_runs) | 14 days | `SSR_RETAIN_RUNS_DAYS` |

Disable with `SSR_LOG_RETENTION=0`.

## Pre-deploy security checks

Run these in CI before every deploy. None of them are wired into `npm run
build` automatically — the build is type-correctness only.

```sh
npm audit --omit=dev --json   # high/critical CVEs in production deps
npm outdated --json           # >2-major-behind security-relevant packages
```

If anything in `next`, `iron-session`, `better-sqlite3`, `ssh2`, `node-forge`,
`tar`, or `nodemailer` shows as critical, treat as a blocker.
