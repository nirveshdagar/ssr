#!/usr/bin/env bash
#
# SSR Dashboard — one-command installer for fresh Ubuntu 22.04 / 24.04 LTS.
#
# Three deployment modes — pick whichever matches your situation:
#
#   1. Production (TLS via Let's Encrypt):
#      curl -fsSL https://raw.githubusercontent.com/nirveshdagar/ssr/main/install.sh \
#        | sudo DASHBOARD_HOSTNAME=ssr.example.com CERTBOT_EMAIL=you@example.com bash
#
#   2. IP-only (no domain, plain HTTP at http://<server-ip>/):
#      curl -fsSL https://raw.githubusercontent.com/nirveshdagar/ssr/main/install.sh | sudo bash
#      → Sets SSR_INSECURE_COOKIES=1 so login works over plain HTTP. Use only
#        on private networks or behind a VPN — there's no transport encryption.
#
#   3. Already-cloned local run:
#      sudo bash /opt/ssr/install.sh
#
# Optional env:
#   DASHBOARD_HOSTNAME — DNS name pointing at this server. If unset, nginx
#                        is still configured but listens with server_name=_
#                        so the dashboard answers on the server's bare IP.
#   CERTBOT_EMAIL      — email for Let's Encrypt expiry notifications.
#                        If unset (or no DASHBOARD_HOSTNAME), TLS is skipped.
#   INSTALL_DIR        — install path (default: /opt/ssr).
#
# Re-running is safe — every step is idempotent.

set -euo pipefail

DASHBOARD_HOSTNAME="${DASHBOARD_HOSTNAME:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
INSTALL_DIR="${INSTALL_DIR:-/opt/ssr}"
REPO_URL="${REPO_URL:-https://github.com/nirveshdagar/ssr.git}"
TOTAL_STEPS=13

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
RED='\033[1;31m'
GREEN='\033[1;32m'
CYAN='\033[1;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

step_n=0
log() {
  step_n=$((step_n + 1))
  echo
  echo -e "${CYAN}[$step_n/$TOTAL_STEPS] ▶ $*${NC}"
}
ok()   { echo -e "${GREEN}    ✓ $*${NC}"; }
warn() { echo -e "${YELLOW}    ⚠ $*${NC}"; }
err()  { echo -e "${RED}    ✗ $*${NC}" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------
[[ $EUID -eq 0 ]] || err "Run as root. Re-run with: sudo bash $0"

if [[ ! -f /etc/os-release ]]; then
  err "Cannot detect OS. /etc/os-release missing — is this Ubuntu?"
fi
. /etc/os-release
case "${VERSION_ID:-}" in
  22.04|24.04) ok "Ubuntu ${VERSION_ID} detected" ;;
  *) err "Unsupported Ubuntu version: ${VERSION_ID:-unknown}. This script is tested on 22.04 and 24.04." ;;
esac

if ! ping -c1 -W2 deb.nodesource.com >/dev/null 2>&1; then
  warn "NodeSource not reachable — apt install will tell you what failed."
fi

# ---------------------------------------------------------------------------
# Step 1 — apt update + base tooling
# ---------------------------------------------------------------------------
log "apt update + base tooling"
export DEBIAN_FRONTEND=noninteractive
apt update -y >/dev/null
apt upgrade -y >/dev/null
apt install -y \
    build-essential git openssl curl ca-certificates gnupg ufw \
    jq lsb-release >/dev/null
ok "base tooling installed"

# ---------------------------------------------------------------------------
# Step 2 — Node.js 22 from NodeSource
# ---------------------------------------------------------------------------
log "Node.js 22"
NODE_MAJOR_NEEDED=22
CURRENT_NODE_MAJOR=$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
if [[ "$CURRENT_NODE_MAJOR" -ge "$NODE_MAJOR_NEEDED" ]]; then
  ok "Node $(node --version) already installed"
else
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt update -y >/dev/null
  apt install -y nodejs >/dev/null
  ok "Node $(node --version) installed (npm $(npm --version))"
fi

# Sanity: must be 22.5+ for node:sqlite
NODE_VER=$(node --version | sed 's/^v//')
NODE_MINOR=$(echo "$NODE_VER" | awk -F. '{print $2}')
if [[ "$CURRENT_NODE_MAJOR" -eq 22 ]] && [[ "$NODE_MINOR" -lt 5 ]]; then
  err "Node 22.5+ required for node:sqlite (got v$NODE_VER). Upgrade your apt cache and re-run."
fi

# ---------------------------------------------------------------------------
# Step 3 — operator user + install dir
# ---------------------------------------------------------------------------
log "ssr operator user"
if id -u ssr >/dev/null 2>&1; then
  ok "user 'ssr' already exists"
else
  useradd -m -s /bin/bash ssr
  ok "created user 'ssr'"
fi
mkdir -p "$INSTALL_DIR"

# ---------------------------------------------------------------------------
# Step 4 — clone or update repo
# ---------------------------------------------------------------------------
log "clone / update repo at $INSTALL_DIR"
# Git CVE-2022-24765 ownership check refuses to operate on a repo owned by a
# different UID than the current user. The installer always runs as root but
# the working dir gets chowned to the 'ssr' operator user later in step 7,
# so the SECOND `sudo bash install.sh` (e.g. an upgrade run) hits "dubious
# ownership". Preemptively whitelisting INSTALL_DIR keeps re-runs idempotent
# without weakening security elsewhere — only this specific path is trusted.
git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
if [[ -d "$INSTALL_DIR/.git" ]]; then
  cd "$INSTALL_DIR"
  git fetch --all --quiet
  # Fast-forward only — refuse to clobber local commits
  git pull --ff-only --quiet || warn "git pull skipped (local divergence) — using current checkout"
  ok "repo updated to $(git rev-parse --short HEAD)"
else
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  ok "repo cloned ($(git rev-parse --short HEAD))"
fi

# ---------------------------------------------------------------------------
# Step 5 — npm ci  (Chromium binary lands inside node_modules/, portable)
# ---------------------------------------------------------------------------
log "npm ci  (~2-4 min, downloads Chromium ~140 MB)"
cd "$INSTALL_DIR/template_v0"
# PLAYWRIGHT_BROWSERS_PATH=0 makes patchright install Chromium INSIDE
# node_modules/ instead of $HOME/.cache/, so a later chown -R ssr fixes
# everything in one shot — no orphaned root-owned cache.
export PLAYWRIGHT_BROWSERS_PATH=0
npm ci >/dev/null
ok "$(npm ls --depth=0 2>/dev/null | head -1)"

# ---------------------------------------------------------------------------
# Step 6 — Chromium runtime libraries (per-Ubuntu via patchright)
# ---------------------------------------------------------------------------
log "Chromium runtime libs"
# patchright install-deps knows the right apt packages for each Ubuntu
# version (handles the t64 rename in 24.04). Idempotent.
npx --yes patchright install-deps chromium >/dev/null
ok "chromium system deps installed"

# ---------------------------------------------------------------------------
# Step 7 — hand ownership to ssr user
# ---------------------------------------------------------------------------
log "ownership → ssr:ssr"
chown -R ssr:ssr "$INSTALL_DIR"
ok "$INSTALL_DIR now owned by ssr"

# ---------------------------------------------------------------------------
# Step 8 — .env.local (generated on first run, reconciled on re-run)
# ---------------------------------------------------------------------------
log ".env.local"
ENVFILE="$INSTALL_DIR/template_v0/.env.local"
# Helper — set or update a key=value line in .env.local. Idempotent.
env_set() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENVFILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENVFILE"
  else
    echo "${key}=${val}" >> "$ENVFILE"
  fi
}
# Helper — remove a line by key from .env.local.
env_unset() {
  local key="$1"
  sed -i "/^${key}=/d" "$ENVFILE" 2>/dev/null || true
}

if [[ ! -f "$ENVFILE" ]]; then
  cp "$INSTALL_DIR/template_v0/.env.example" "$ENVFILE"
  SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")
  echo "" >> "$ENVFILE"
  echo "# --- Auto-generated by install.sh ---" >> "$ENVFILE"
  echo "SSR_SESSION_PASSWORD=$SECRET" >> "$ENVFILE"
  ok "generated with fresh SSR_SESSION_PASSWORD"
else
  ok ".env.local exists — preserving SSR_SESSION_PASSWORD; reconciling deploy flags"
fi

# SSR_TRUST_PROXY=1 is safe whenever nginx fronts the app (always, in
# this script) — nginx's config below replaces XFF with the real peer IP.
env_set "SSR_TRUST_PROXY" "1"

if [[ -z "$DASHBOARD_HOSTNAME" ]] || [[ -z "$CERTBOT_EMAIL" ]]; then
  # Plain HTTP — disable cookie Secure flag so the browser actually sends
  # the session cookie back. Without this, login appears to succeed (200 OK)
  # but the next request lands unauthenticated.
  env_set "SSR_INSECURE_COOKIES" "1"
else
  # We're in TLS mode — strip any leftover insecure-cookie flag from a
  # previous IP-only install on this same box.
  env_unset "SSR_INSECURE_COOKIES"
fi

chown ssr:ssr "$ENVFILE"
chmod 600 "$ENVFILE"

# ---------------------------------------------------------------------------
# Step 9 — production build  (run as ssr so build artifacts are ssr-owned)
# ---------------------------------------------------------------------------
log "npm run build  (~30-90 s)"
sudo -u ssr -H bash -lc "cd $INSTALL_DIR/template_v0 && PLAYWRIGHT_BROWSERS_PATH=0 npm run build" \
  | tail -3
ok "build complete"

# ---------------------------------------------------------------------------
# Step 10 — systemd unit
# ---------------------------------------------------------------------------
log "systemd service"
cat > /etc/systemd/system/ssr-dashboard.service <<'UNIT'
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
Environment=PLAYWRIGHT_BROWSERS_PATH=0
ExecStart=/usr/bin/node /opt/ssr/template_v0/node_modules/next/dist/bin/next start -p 3000
Restart=on-failure
RestartSec=5
# Drain in-flight pipelines on graceful stop. SIGTERM handler in
# instrumentation.ts stops the job pool; recoverOrphans() picks up any
# leftovers on next start.
TimeoutStopSec=300
KillMode=mixed

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ssr-dashboard >/dev/null

# Wait up to 30s for the health endpoint to come up
echo -n "    waiting for /api/health "
for i in {1..30}; do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo
    HEALTH=$(curl -fsS http://127.0.0.1:3000/api/health)
    ok "dashboard alive: $HEALTH"
    break
  fi
  echo -n "."
  sleep 1
  if [[ $i -eq 30 ]]; then
    echo
    err "dashboard didn't bind :3000 in 30 s — inspect with: journalctl -u ssr-dashboard -n 80 --no-pager"
  fi
done

# ---------------------------------------------------------------------------
# Step 11 — firewall
# ---------------------------------------------------------------------------
log "ufw firewall"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ok "$(ufw status | head -1)"

# ---------------------------------------------------------------------------
# Step 12 — nginx
# ---------------------------------------------------------------------------
log "nginx reverse proxy"
apt install -y nginx >/dev/null
# server_name resolves to the operator-supplied hostname OR `_` (catch-all)
# when there's no domain — that means the dashboard answers on the server's
# bare IP at port 80 without any DNS configuration.
NGINX_SERVER_NAME="${DASHBOARD_HOSTNAME:-_}"
cat > /etc/nginx/sites-available/ssr-dashboard <<EOF
server {
    listen 80 default_server;
    server_name $NGINX_SERVER_NAME;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        # Replace any client-supplied X-Forwarded-For with the real peer.
        # SSR_TRUST_PROXY=1 in .env.local relies on this — without it,
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
if nginx -t 2>&1 | grep -q "syntax is ok"; then
  systemctl reload nginx
  if [[ -z "$DASHBOARD_HOSTNAME" ]]; then
    ok "nginx reloaded — dashboard reachable on http://<server-ip>/"
  else
    ok "nginx reloaded — site enabled at http://$DASHBOARD_HOSTNAME/"
  fi
else
  err "nginx config test failed — see: nginx -t"
fi

# ---------------------------------------------------------------------------
# Step 13 — Let's Encrypt TLS
# ---------------------------------------------------------------------------
log "Let's Encrypt TLS"
if [[ -z "$DASHBOARD_HOSTNAME" ]]; then
  warn "skipped (no DASHBOARD_HOSTNAME)"
elif [[ -z "$CERTBOT_EMAIL" ]]; then
  warn "skipped (no CERTBOT_EMAIL — re-run with CERTBOT_EMAIL=you@example.com bash $0)"
  warn "  meanwhile dashboard is reachable on plain HTTP at http://$DASHBOARD_HOSTNAME/"
else
  apt install -y certbot python3-certbot-nginx >/dev/null
  if certbot --nginx -d "$DASHBOARD_HOSTNAME" \
       --non-interactive --agree-tos --email "$CERTBOT_EMAIL" \
       --redirect --keep-until-expiring 2>&1 | tail -10
  then
    ok "TLS active on https://$DASHBOARD_HOSTNAME/"
  else
    warn "certbot failed — most common cause: DNS not pointing at this server yet."
    warn "  check: dig +short $DASHBOARD_HOSTNAME"
    warn "  retry: certbot --nginx -d $DASHBOARD_HOSTNAME --email $CERTBOT_EMAIL --agree-tos --redirect"
  fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
DASHBOARD_URL=""
PUBLIC_IP=$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "<server-ip>")
if [[ -n "$DASHBOARD_HOSTNAME" && -n "$CERTBOT_EMAIL" ]]; then
  DASHBOARD_URL="https://$DASHBOARD_HOSTNAME/"
elif [[ -n "$DASHBOARD_HOSTNAME" ]]; then
  DASHBOARD_URL="http://$DASHBOARD_HOSTNAME/  (TLS not configured — re-run with CERTBOT_EMAIL=...)"
else
  DASHBOARD_URL="http://$PUBLIC_IP/  (plain HTTP; SSR_INSECURE_COOKIES=1 set in .env.local)"
fi

cat <<EOF

${GREEN}════════════════════════════════════════════════════════════════════
  ✓ SSR Dashboard installed
════════════════════════════════════════════════════════════════════${NC}

  ${CYAN}Service${NC}    systemctl status ssr-dashboard
  ${CYAN}Logs${NC}       journalctl -u ssr-dashboard -f
  ${CYAN}Health${NC}     curl http://127.0.0.1:3000/api/health
  ${CYAN}URL${NC}        $DASHBOARD_URL

  ${YELLOW}Next steps:${NC}
    1. Open the dashboard in your browser
    2. /settings/security → set the operator password
    3. /settings → fill in API keys (CF, DO, SA, Spaceship, LLM)
    4. /cloudflare → add your first CF DNS Global Key
    5. /servers → provision your first DO droplet
    6. /domains → add a domain to start the pipeline

  ${YELLOW}Backups${NC} land daily in /opt/ssr/data/backups/ (7-day retention).
  Off-host backup recommended — see UBUNTU_INSTALL.md "Backups" section.

EOF
