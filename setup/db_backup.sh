#!/bin/bash
# Nightly SQLite backup via SQLite's online backup API (safe under WAL).
# Keeps the last 14 backups; compresses each to ~20% of original size.
#
# Install:
#   sudo cp setup/db_backup.sh /opt/ssr/db_backup.sh
#   sudo chmod +x /opt/ssr/db_backup.sh
#   sudo mkdir -p /opt/ssr/backups
#   sudo chown ssr:ssr /opt/ssr/backups
#   # Crontab (as ssr user) — 03:15 daily:
#   15 3 * * * /opt/ssr/db_backup.sh >> /opt/ssr/backups/backup.log 2>&1

set -eu

DB=/opt/ssr/data/ssr.db
OUT_DIR=/opt/ssr/backups
RETAIN=14

stamp=$(date -u +%Y%m%d-%H%M%S)
out="$OUT_DIR/ssr-$stamp.db"

# SQLite online backup — safe even with active readers/writers (WAL mode).
sqlite3 "$DB" ".backup '$out'"
gzip -9 "$out"

# Prune — keep the most recent $RETAIN files.
find "$OUT_DIR" -maxdepth 1 -type f -name 'ssr-*.db.gz' \
    -printf '%T@ %p\n' | sort -n | head -n -$RETAIN \
    | awk '{ $1=""; print substr($0,2) }' | xargs -r rm --

echo "[$(date -u +%FT%TZ)] backed up -> $out.gz  (keeping last $RETAIN)"
