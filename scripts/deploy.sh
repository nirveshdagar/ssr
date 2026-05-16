#!/usr/bin/env bash
# Production deploy for the SSR dashboard on the DO droplet.
#
# Codifies the ONLY recovery proven to work (2026-05-16). The old
# `cd /opt/ssr && git pull` silently ABORTED for days on the committed
# next-env.d.ts and the droplet ran stale code while deploys "succeeded".
# `fetch + reset --hard origin/main` sidesteps that and any local cruft —
# correct for a deploy box that must mirror the repo.
#
# Usage (on the droplet):  bash /opt/ssr/scripts/deploy.sh
set -euo pipefail

SSR_DIR="${SSR_DIR:-/opt/ssr}"
APP_DIR="$SSR_DIR/template_v0"
SERVICE="${SSR_SERVICE:-ssr-dashboard}"

echo "==> Deploy starting in $SSR_DIR"
BEFORE="$(git -C "$SSR_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "    current : $BEFORE"

git -C "$SSR_DIR" fetch origin
# Hard-reset to the remote: discards the auto-generated next-env.d.ts (Next
# regenerates it on build) and any other deploy-box cruft. No merge, no
# abort, no pathspec games.
git -C "$SSR_DIR" reset --hard origin/main

AFTER="$(git -C "$SSR_DIR" rev-parse --short HEAD)"
echo "    updated : $AFTER"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "    (already at $AFTER — building/restarting anyway to be safe)"
fi
git -C "$SSR_DIR" log --oneline -1

echo "==> Building (cd $APP_DIR — package.json is NOT at repo root)"
cd "$APP_DIR"
npm run build

echo "==> Restarting $SERVICE"
systemctl restart "$SERVICE"
sleep 3
systemctl --no-pager --lines=0 status "$SERVICE" || true

echo
echo "==> Deployed: $BEFORE -> $AFTER"
echo "    Verify the running build matches with:  curl -s localhost:3000/api/health"
echo "    (health now reports the git SHA — it should read $AFTER)"
