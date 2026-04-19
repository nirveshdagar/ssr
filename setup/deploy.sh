#!/bin/bash
# Safe one-shot deploy for the SSR dashboard.
#
# Flow:
#   1. Abort if repo has uncommitted changes (don't silently discard work)
#   2. git fetch + fast-forward pull (no merges ever)
#   3. pip install — only if requirements.txt changed
#   4. pytest — if ANY test fails, roll back to the prior commit and exit 1
#   5. systemctl restart ssr-dashboard
#   6. curl /healthz — if the service doesn't come up, roll back + restart
#
# Rollback is git-based: the prior commit SHA is captured up front, and any
# failure path does `git reset --hard $OLD_SHA` so the running directory
# matches the running service.
#
# Run: sudo /opt/ssr/setup/deploy.sh
# (must be root so systemctl works; git/pytest run as the ssr user)

set -euo pipefail

REPO=/opt/ssr
SERVICE=ssr-dashboard
HEALTHZ=http://127.0.0.1:8000/healthz

cd "$REPO"

# 1. Safety: uncommitted changes = abort.
if ! sudo -u ssr git diff --quiet || ! sudo -u ssr git diff --cached --quiet; then
    echo "[deploy] ABORT: uncommitted changes in $REPO"
    sudo -u ssr git status --short
    exit 1
fi

# 2. Record rollback target.
OLD_SHA=$(sudo -u ssr git rev-parse HEAD)
echo "[deploy] current commit: $OLD_SHA"

# 3. Fetch + check for updates.
sudo -u ssr git fetch --quiet
NEW_SHA=$(sudo -u ssr git rev-parse '@{upstream}')
if [ "$OLD_SHA" = "$NEW_SHA" ]; then
    echo "[deploy] already at $OLD_SHA — nothing to do"
    exit 0
fi

echo "[deploy] fast-forward $OLD_SHA → $NEW_SHA"
sudo -u ssr git merge --ff-only "$NEW_SHA"

# 4. Install new deps ONLY if requirements.txt changed.
if sudo -u ssr git diff --name-only "$OLD_SHA" "$NEW_SHA" \
     | grep -qx 'requirements.txt'; then
    echo "[deploy] requirements.txt changed — pip installing..."
    sudo -u ssr "$REPO/venv/bin/pip" install -q -r "$REPO/requirements.txt"
fi

# 5. Run tests. Failure = roll back, don't restart.
echo "[deploy] running pytest..."
if ! sudo -u ssr "$REPO/venv/bin/python" -m pytest tests/ -q; then
    echo "[deploy] TESTS FAILED — rolling back to $OLD_SHA"
    sudo -u ssr git reset --hard "$OLD_SHA"
    exit 1
fi
echo "[deploy] tests passed"

# 6. Restart service.
echo "[deploy] restarting $SERVICE..."
systemctl restart "$SERVICE"

# 7. Give it ~3s to boot, then verify via /healthz.
# If healthz fails, roll back code AND restart so the running process matches
# the on-disk code. This is the ONE reason we need a full round-trip test.
sleep 3
if curl -sf --max-time 5 "$HEALTHZ" >/dev/null; then
    echo "[deploy] ✓ OK — $SERVICE is up at $NEW_SHA"
    exit 0
else
    echo "[deploy] HEALTHZ FAILED after restart — rolling back to $OLD_SHA"
    sudo -u ssr git reset --hard "$OLD_SHA"
    systemctl restart "$SERVICE"
    # Give rolled-back service a moment + verify once more
    sleep 3
    if curl -sf --max-time 5 "$HEALTHZ" >/dev/null; then
        echo "[deploy] rolled back successfully — service running at $OLD_SHA"
    else
        echo "[deploy] ROLLBACK ALSO FAILED — service is DOWN. Inspect: journalctl -u $SERVICE -n 100"
    fi
    exit 1
fi
