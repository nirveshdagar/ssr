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

Set `X-Forwarded-For` so the login throttle and audit log capture client IPs
correctly. The middleware already reads the first IP from that header.

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

Back up `data/ssr.db` AND `data/.ssr_secret_fernet` together — the encrypted
settings are useless without the matching key file. Both apps see the WAL-
mode SQLite, so an `sqlite3 ssr.db ".backup target.db"` captures a consistent
snapshot without stopping the app.
