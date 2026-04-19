# SSR Dashboard — Production Deployment

Target: a fresh Ubuntu 22.04+ droplet, behind nginx + TLS.

## 1. Server prep (5 min)

```bash
# As root
adduser --disabled-password --gecos '' ssr
apt-get update
apt-get install -y python3-venv python3-pip git nginx sqlite3
```

## 2. Fetch + install code (2 min)

```bash
sudo -u ssr -H bash <<'EOF'
cd /opt && git clone <your-repo-url> ssr
cd /opt/ssr
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
# Install patchright's headless browser for SA UI-automated SSL install
./venv/bin/patchright install chromium
EOF
sudo chown -R ssr:ssr /opt/ssr
```

## 3. Environment config (1 min)

```bash
sudo cp /opt/ssr/.env.example /etc/ssr.env
sudo chmod 600 /etc/ssr.env
sudo chown ssr:ssr /etc/ssr.env
# Review /etc/ssr.env — SSR_BEHIND_PROXY=1 and SSR_HTTPS_ONLY=1 are the
# production defaults.
```

## 4. systemd + auto-start (1 min)

```bash
sudo cp /opt/ssr/setup/ssr-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ssr-dashboard
sudo systemctl status ssr-dashboard      # should be "active (running)"
journalctl -u ssr-dashboard -f           # live logs
```

## 5. TLS + nginx (5 min)

```bash
sudo cp /opt/ssr/setup/nginx.conf.example /etc/nginx/sites-available/ssr-dashboard
# Edit: replace every DASHBOARD_FQDN with your actual hostname
sudo nano /etc/nginx/sites-available/ssr-dashboard

# Issue a cert with certbot (standalone or nginx plugin — your choice)
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot certonly --nginx -d DASHBOARD_FQDN

# Enable the site
sudo ln -s /etc/nginx/sites-available/ssr-dashboard /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default   # remove default if present
sudo nginx -t && sudo systemctl reload nginx
```

Open `https://DASHBOARD_FQDN/healthz` — should return `{"status":"ok"}`.

## 6. First login (1 min)

Open `https://DASHBOARD_FQDN/` — no password yet, access is open.
Go to **Settings → Dashboard Security**, type a strong password, click **Save**.
You'll be logged out — log back in with the new password.

## 7. DB backups + log pruning (3 min)

```bash
sudo cp /opt/ssr/setup/db_backup.sh /opt/ssr/
sudo chmod +x /opt/ssr/db_backup.sh
sudo mkdir -p /opt/ssr/backups
sudo chown ssr:ssr /opt/ssr/backups /opt/ssr/db_backup.sh

# Cron as the ssr user:
sudo -u ssr crontab - <<'CRON'
# Daily DB backup at 03:15 UTC (keeps 14 days)
15 3 * * * /opt/ssr/db_backup.sh >> /opt/ssr/backups/backup.log 2>&1

# Daily log prune at 03:30 UTC — trims pipeline_log to 30 days + VACUUMs
30 3 * * * sqlite3 /opt/ssr/data/ssr.db < /opt/ssr/setup/log_prune.sql
CRON
```

## 8. Configure credentials (in the dashboard UI)

1. **CF Keys Pool** → paste your Cloudflare email + Global API Key for each account
2. **Cloudflare → Verify Account IDs** button to populate `cf_account_id` for each key
3. **Spaceship** → API Key + Secret
4. **DigitalOcean** → primary PAT (+ backup PAT from a second DO account, optional)
5. **ServerAvatar** → API Key + Org ID + dashboard email/password (for UI-automated SSL install)
6. **LLM** → pick provider + paste API key, hit **Test Key**
7. **Alerts & Notifications** → enable channels + paste creds, hit **Send test** for each

## 9. Smoke test

1. Add a test domain via **Domains → Add Domain**
2. Hit **Run Pipeline**
3. Open **Watcher** to see heartbeat + per-step progress

## Maintenance

| Task | Command |
|---|---|
| **Deploy new code** (recommended) | `sudo /opt/ssr/setup/deploy.sh` |
| Restart app | `sudo systemctl restart ssr-dashboard` |
| View logs | `journalctl -u ssr-dashboard -f` |
| Force DB backup | `sudo -u ssr /opt/ssr/db_backup.sh` |
| Inspect DB | `sudo -u ssr sqlite3 /opt/ssr/data/ssr.db` |
| List backups | `ls -lht /opt/ssr/backups/` |
| Restore a backup | `sudo systemctl stop ssr-dashboard && sudo -u ssr zcat /opt/ssr/backups/ssr-XXXX.db.gz > /opt/ssr/data/ssr.db && sudo systemctl start ssr-dashboard` |
| Run tests ad-hoc | `sudo -u ssr /opt/ssr/venv/bin/python -m pytest /opt/ssr/tests/` |
| Rotate secret-encryption key | `sudo -u ssr /opt/ssr/venv/bin/python -c "from modules.secrets_vault import rotate_secrets; print(rotate_secrets('/opt/ssr/data/ssr.db'))"` |

### The `deploy.sh` flow (what happens when you run it)

1. Refuses if the working copy has uncommitted changes — won't silently discard work.
2. Captures the current commit SHA as rollback target.
3. `git fetch` + fast-forward pull (never a merge — if upstream has diverged, you're in unexpected state and the script aborts).
4. `pip install` — only if `requirements.txt` actually changed.
5. `pytest tests/` — if ANY test fails, `git reset --hard` to the prior commit and exit 1. Service is NOT restarted.
6. `systemctl restart ssr-dashboard`.
7. Waits 3s and hits `/healthz`. If the service didn't come up, rolls code back AND restarts so the running process matches the on-disk code. If rollback also fails, surfaces a `journalctl` hint.

Net effect: either the new commit is live and healthy, or the old commit is live and healthy. You never get a broken service running code that contradicts what's checked out.

## Troubleshooting

**Dashboard returns 502 from nginx** — check `journalctl -u ssr-dashboard -n 100` for the Python error. Common: missing `/etc/ssr.env` or a setting that references a non-existent directory.

**`database is locked`** — shouldn't happen anymore (F2 fix added 10s busy-timeout), but if it does, it means a write transaction has been held >10s. Check `journalctl` for the stack.

**Auto-migration didn't fire on a dead server** — only runs when `auto_migrate_enabled=1` in Settings. The dead-flip happens regardless; check the Servers page for status=`dead`, then click **Migrate Now** manually.

**All DO tokens rejected** — nginx is the fastest way to see the alert fan-out, since it'll hit email + Telegram + WhatsApp simultaneously. Check Settings → DigitalOcean → Test both tokens.

**Grey-cloud leakage after a crash** — the app re-runs a recovery sweep on every startup (R4 fix). Look for `grey_cloud_recovery` entries in pipeline_log.
