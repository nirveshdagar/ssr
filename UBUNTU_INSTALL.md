# SSR Dashboard — Ubuntu install guide

**Tested on Ubuntu 22.04 LTS and 24.04 LTS, fresh server.** Every command is copy-paste ready, idempotent where possible, and runs in order without prompts.

If you hit an error, see the [Troubleshooting](#troubleshooting) section at the bottom — every common failure is listed there with the exact fix.

---

## 0. Prerequisites

You need:
- A fresh Ubuntu 22.04 or 24.04 LTS server (any cloud provider, 1 GB RAM minimum, 2 GB recommended)
- SSH access as `root` or a user with `sudo`
- A domain name pointed at the server (for the dashboard URL — optional during install, you can skip TLS for first boot)
- API credentials you'll add via the dashboard later: Cloudflare DNS Global Keys, DigitalOcean tokens, ServerAvatar API key, Spaceship API key, at least one LLM key

This guide does **everything as root** for clarity, then drops the dashboard to a non-root `ssr` user at the end. If you're already on a sudo user, prefix the commands with `sudo` where needed.

---

## 1. System update + base tooling

```bash
# Become root if you're not already
sudo -i

# Update package lists and apply security patches
apt update
apt upgrade -y

# Install build essentials, git, openssl, curl, ca-certificates, ufw
apt install -y \
    build-essential \
    git \
    openssl \
    curl \
    ca-certificates \
    gnupg \
    ufw
```

---

## 2. Install Node.js 22 (LTS)

The dashboard requires **Node 22.5+** (uses the built-in `node:sqlite` module). Ubuntu's apt repos ship older versions, so install from [NodeSource](https://github.com/nodesource/distributions):

```bash
mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg

echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list

apt update
apt install -y nodejs

# Verify (must report v22.5.0 or higher)
node --version
npm --version
```

**Expected output**: `v22.x.x` (≥ 22.5.0) and npm `10.x.x` or higher.

---

## 3. Create the operator user + install directory

```bash
useradd -m -s /bin/bash ssr
mkdir -p /opt/ssr
# We'll chown to ssr AFTER npm ci so root owns node_modules during the install
# (patchright install-deps needs sudo and is cleaner as root). Permissions
# get fixed up at the end of step 6.
```

---

## 4. Clone the repository

```bash
cd /opt/ssr
git clone https://github.com/nirveshdagar/ssr.git .
# The trailing dot clones INTO /opt/ssr (no nested ssr/ssr/ directory)

ls -la
# Expected: README.md, UBUNTU_INSTALL.md, template_v0/, audit/, data/, .git/
```

---

## 5. Install npm dependencies

```bash
cd /opt/ssr/template_v0
npm ci
```

`npm ci` (not `npm install`) reads `package-lock.json` exactly — same versions on every machine. The first run takes 2-4 minutes.

**Expected output**: `added N packages, and audited N packages in Xs` followed by `0 vulnerabilities`.

The `postinstall` hook auto-runs `patchright install chromium`. If it fails (network/disk), the message tells you to retry — that's harmless, the dashboard runs fine without the browser binary.

---

## 6. Install Chromium runtime libraries (handles 22.04 + 24.04 transparently)

The dashboard uses [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (a stealth Playwright fork) as a fallback for ServerAvatar SSL installs when the REST API fails. Patchright's `install-deps` knows the correct package names for each Ubuntu version (the `t64` rename from 24.04 is handled automatically):

```bash
# As root, from /opt/ssr/template_v0
npx patchright install-deps chromium
```

This is the canonical command — it figures out the right `apt install` packages whether you're on 22.04 (`libasound2`, `libatk1.0-0`) or 24.04 (`libasound2t64`, `libatk1.0-0t64`).

Then make sure the browser binary itself is installed:

```bash
npx patchright install chromium
```

Now hand ownership over to the `ssr` user:

```bash
chown -R ssr:ssr /opt/ssr
```

Switch to the operator user for the rest of the install:

```bash
su - ssr
cd /opt/ssr/template_v0
```

> **From this point on, every command runs as `ssr` (you'll see `ssr@host:...$`).**

---

## 7. Configure environment

```bash
cp .env.example .env.local

# Generate a fresh 48-byte session secret (base64-encoded)
SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")
echo "SSR_SESSION_PASSWORD=$SECRET" >> .env.local

# Recommended for production behind a reverse proxy:
echo "SSR_TRUST_PROXY=1" >> .env.local

# Lock down the file — it now contains a session-signing secret
chmod 600 .env.local
```

Open `.env.local` (`nano .env.local`) and review the optional knobs. The defaults are sane; the most common ones to tune later:

```bash
# SSR_JOB_WORKERS=4              # in-process pipeline workers
# SSR_BACKUP_KEEP_DAYS=14        # daily-backup retention
# SSR_LIVE_CHECKER=1             # enable HTTPS liveness probe
```

---

## 8. Build the application

```bash
cd /opt/ssr/template_v0
npm run build
```

The build is **strict** — TypeScript errors fail the build (`ignoreBuildErrors: false`). If this step fails, the deploy fails — fix the error before proceeding.

**Expected output**: a route table ending with `Build completed in Xs`.

---

## 9. First-run smoke test

Before wiring up systemd, confirm the dashboard starts cleanly:

```bash
cd /opt/ssr/template_v0
npm run start &              # start in background
sleep 5                      # give it a moment to bind
curl -s http://127.0.0.1:3000/api/health
echo                         # newline
kill %1                      # stop the background process
```

**Expected output**: `{"status":"ok","checks":{"db":"ok","fernet":"ok"}}`

If `db` is not `ok`, see [Troubleshooting](#troubleshooting).

---

## 10. systemd service

Run the dashboard as a system service so it survives reboots and crashes. **Switch back to root** for this step (exit the `ssr` shell):

```bash
exit          # back to root
```

```bash
cat > /etc/systemd/system/ssr-dashboard.service <<'EOF'
[Unit]
Description=SSR Dashboard (Next.js)
After=network.target

[Service]
Type=simple
User=ssr
Group=ssr
WorkingDirectory=/opt/ssr/template_v0
EnvironmentFile=/opt/ssr/template_v0/.env.local
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/node /opt/ssr/template_v0/node_modules/next/dist/bin/next start -p 3000
Restart=on-failure
RestartSec=5
# Don't kill long-running pipeline jobs on graceful stop — give them up to
# 5 min. The SIGTERM handler in instrumentation.ts drains the job pool;
# recoverOrphans() picks up anything truncated on next start.
TimeoutStopSec=300
KillMode=mixed

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ssr-dashboard
systemctl status ssr-dashboard --no-pager
```

**Expected output**: `Active: active (running)`.

Stream the logs to confirm it's healthy:

```bash
journalctl -u ssr-dashboard -n 30 --no-pager
# Look for: "Listening on" or no errors. Press q to exit.
```

---

## 11. nginx reverse proxy + Let's Encrypt TLS

Install nginx and certbot:

```bash
apt install -y nginx certbot python3-certbot-nginx
```

Set your dashboard hostname (replace with your real domain):

```bash
DASHBOARD_HOSTNAME="dashboard.example.com"
```

Create the nginx site:

```bash
cat > /etc/nginx/sites-available/ssr-dashboard <<EOF
server {
    listen 80;
    server_name ${DASHBOARD_HOSTNAME};

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        # IMPORTANT: replace any client-supplied X-Forwarded-For with the real
        # peer. SSR_TRUST_PROXY=1 in .env.local depends on this — without it,
        # login throttle and audit-log actor IPs can be forged.
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 600;
        proxy_send_timeout 600;
        client_max_body_size 16M;
    }
    location = /healthz {
        proxy_pass http://127.0.0.1:3000/api/health;
        access_log off;
    }
}
EOF

ln -sf /etc/nginx/sites-available/ssr-dashboard /etc/nginx/sites-enabled/ssr-dashboard
rm -f /etc/nginx/sites-enabled/default
nginx -t                          # must report: syntax is ok / test is successful
systemctl reload nginx
```

Get a Let's Encrypt cert (interactive — certbot will ask for an email):

```bash
certbot --nginx -d ${DASHBOARD_HOSTNAME}
# Follow the prompts. Choose option 2 (redirect HTTP → HTTPS).
```

Verify auto-renewal:

```bash
systemctl status certbot.timer --no-pager
curl -sI https://${DASHBOARD_HOSTNAME}/ | head -3
# Expected: HTTP/2 200 (or 307 redirect to /login)
```

---

## 12. Firewall (ufw)

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
ufw status
```

You should see `OpenSSH ALLOW` and `Nginx Full ALLOW`. Port 3000 stays internal — nginx fronts it.

---

## 13. First login + initial config

Open `https://your-dashboard-domain/` in a browser. You'll land on `/login`.

1. Click **Skip to dashboard**, then navigate to `/settings/security`.
2. **Set the operator password** (12+ characters recommended). Save → you'll be logged out.
3. Log back in with the new password.
4. Fill in your API keys under **Settings**:
   - **Cloudflare** — `cloudflare_account_id`, `cloudflare_workers_ai_token` (optional, for the AI pool single-account mode)
   - **DigitalOcean** — `do_api_token`, `do_api_token_backup` (recommended for failover)
   - **ServerAvatar** — `serveravatar_api_key`, `serveravatar_org_id`, `sa_dashboard_email`, `sa_dashboard_password`
   - **Spaceship** — `spaceship_api_key`, `spaceship_api_secret`, registrant contact info
   - **LLM** — pick a provider, paste an API key (`llm_api_key_anthropic`, `llm_api_key_openai`, etc.)
   - **Server root password** — used for SSH into provisioned droplets
5. **`/cloudflare`** → click **Add CF Key** to register one DNS Global Key. The dashboard verifies it against `/accounts` before storing.
6. **`/servers`** → click **Provision new** (kicks off DO + ServerAvatar agent install, takes 5-15 min) OR **Import existing** if you already have an SA-managed server.
7. **`/domains`** → click **Add domain**. Pipeline starts immediately; watch progress on `/watcher`.

---

## 14. Verify production-readiness

```bash
# Health check (public — no auth)
curl -s https://your-dashboard-domain/healthz | jq
# Expected: {"status":"ok","checks":{"db":"ok","fernet":"ok"}}

# Service health
sudo systemctl is-active ssr-dashboard      # active
sudo systemctl is-enabled ssr-dashboard     # enabled

# Disk usage of the DB
ls -lh /opt/ssr/data/ssr.db
ls -lh /opt/ssr/data/.ssr_secret_fernet     # mode 600 — never readable by others

# First backup runs 60 seconds after first boot, then daily
ls -lh /opt/ssr/data/backups/ 2>/dev/null
# After ~1 minute of uptime: ssr-YYYYMMDD.db + .ssr_secret_fernet-YYYYMMDD
```

If everything checks out, **you're live**.

---

## Backups — IMPORTANT

The dashboard auto-rotates 7 days of local backups in `/opt/ssr/data/backups/`. **For disaster recovery, copy these off-host.**

As the `ssr` user:

```bash
sudo -iu ssr
crontab -e
```

Append (replace `s3://my-bucket/ssr-backups/` with your real off-host target — S3, B2, restic, scp to another box, etc.):

```cron
# Sync local backups to off-host storage every night at 03:00
0 3 * * * aws s3 sync /opt/ssr/data/backups/ s3://my-bucket/ssr-backups/ >/dev/null 2>&1
```

If you wipe `data/` without the Fernet key file, every encrypted secret is unrecoverable. The dashboard refuses to auto-generate a fresh key in production when encrypted rows exist — you'll need a working backup.

---

## Updating to a new version

```bash
sudo systemctl stop ssr-dashboard
sudo -iu ssr
cd /opt/ssr
git pull
cd template_v0
npm ci
npm run build
exit
sudo systemctl start ssr-dashboard
sudo systemctl status ssr-dashboard --no-pager
```

Schema migrations are automatic — `lib/init-schema.ts` adds new columns/tables on first connection (`tryAlter()` swallows "already exists" errors). No manual migration step.

---

## Troubleshooting

### `node --version` reports v18 or v20 after step 2

Your apt is still pointing at Ubuntu's default Node. Re-check `/etc/apt/sources.list.d/nodesource.list` exists and contains `node_22.x`, then:

```bash
apt update
apt install -y --reinstall nodejs
node --version
```

### `npm ci` fails with `gyp ERR!` or native-module build errors

Make sure step 1 (`build-essential`) and step 2 (Node 22) ran cleanly. Node 22.5+ uses built-in `node:sqlite` (no native build), so genuine compile errors are rare — when they happen, it's almost always an old Node version.

### `npx patchright install-deps chromium` asks for sudo password

You're not running as root. Either become root (`sudo -i`) and re-run, OR prefix the command with `sudo`:

```bash
sudo npx patchright install-deps chromium
```

### `npm run start` exits with `SSR_SESSION_PASSWORD must be set to a 32+ char random string in production`

You skipped step 7. Re-run:

```bash
SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")
echo "SSR_SESSION_PASSWORD=$SECRET" >> /opt/ssr/template_v0/.env.local
```

### `/api/health` returns `{"status":"degraded","checks":{"db":"error: ..."}}`

The SQLite path isn't writable. Fix ownership:

```bash
sudo chown -R ssr:ssr /opt/ssr/data /opt/ssr/template_v0
sudo systemctl restart ssr-dashboard
```

### `/api/health` returns `{"checks":{"fernet":"missing"}}`

Normal on first boot — the Fernet key gets auto-generated on the first encrypted-write. After you set the dashboard password and save any setting, the key file appears at `/opt/ssr/data/.ssr_secret_fernet`. If it persists empty after you've used the dashboard, check ownership:

```bash
sudo ls -la /opt/ssr/data/.ssr_secret_fernet
# Should be: -rw------- ssr ssr
```

### Patchright Chromium download fails during `npm ci`

Network blip or disk full. The dashboard runs fine without it; the SA UI fallback path just won't work. To retry as root from `/opt/ssr/template_v0`:

```bash
npx patchright install chromium
```

### nginx `502 Bad Gateway` after `systemctl start`

The dashboard process didn't bind port 3000. Check:

```bash
sudo journalctl -u ssr-dashboard -n 80 --no-pager
sudo ss -tlnp | grep 3000   # should show node listening on 127.0.0.1:3000
```

If nothing's on 3000, scroll the journal for the actual error (usually a syntax error in `.env.local`, or `npm run build` not having run before `systemctl start`).

### Certbot fails with `Connection refused` or `DNS problem`

Your domain's A record isn't pointing at this server, OR the firewall is blocking 80/443. Verify:

```bash
dig +short your-dashboard-domain
# Should return THIS server's public IP

sudo ufw status
# Nginx Full must be ALLOW
```

### `git pull` fails with "Your local changes would be overwritten"

You've edited a tracked file by hand. Either commit your changes or stash them:

```bash
git stash
git pull
git stash pop
```

`.env.local` is gitignored — those edits are safe.

### `next build` fails with TypeScript errors

The build is strict. The error message includes file:line — fix the error in source. Don't flip `ignoreBuildErrors: true` in `next.config.mjs`; that masks real bugs that would surface in prod.

### Service starts but immediately stops (Restart loop)

`systemctl status ssr-dashboard` will show `Active: activating (auto-restart)`. Get the actual error:

```bash
sudo journalctl -u ssr-dashboard -n 100 --no-pager
```

The most common culprit is `.env.local` having wrong line endings (Windows CRLF) or the file being unreadable. Fix:

```bash
sudo chmod 600 /opt/ssr/template_v0/.env.local
sudo chown ssr:ssr /opt/ssr/template_v0/.env.local
sudo dos2unix /opt/ssr/template_v0/.env.local 2>/dev/null  # or sed -i 's/\r$//' .env.local
sudo systemctl restart ssr-dashboard
```

---

## What this install gives you

After step 14 you have:

- ✅ Next.js dashboard on `https://your-domain/` behind nginx + Let's Encrypt
- ✅ systemd-managed service that restarts on crash, drains gracefully on stop
- ✅ Auto-renewing SSL cert (every 60 days via certbot.timer)
- ✅ ufw firewall — only SSH + 80/443 exposed
- ✅ Daily SQLite + Fernet-key backup with 7-day rotation
- ✅ Daily log retention (pipeline_log 30d, audit_log 90d)
- ✅ In-process job pool with auto-heal sweeper
- ✅ SIGTERM-safe shutdown
- ✅ `0 npm-audit vulnerabilities`, 82 tests passing, typecheck strict

You're ready to start running domains.

---

## Operations reference

For day-2 ops (tuning workers, retention windows, custom Fernet key paths, etc.), see [`template_v0/DEPLOY.md`](./template_v0/DEPLOY.md). For the production audit and what was hardened, see [`audit/SUMMARY.md`](./audit/SUMMARY.md).
