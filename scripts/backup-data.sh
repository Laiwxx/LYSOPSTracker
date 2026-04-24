#!/bin/bash
# Nightly backup of data/ directory — keeps 7 rolling daily snapshots
# Add to crontab: 0 2 * * * /home/ubuntu/ops-tracker/scripts/backup-data.sh

BACKUP_DIR="/home/ubuntu/ops-tracker-backups"
DATA_DIR="/home/ubuntu/ops-tracker/data"
DATE=$(date +%Y-%m-%d)
DAY_OF_WEEK=$(date +%u)  # 1=Mon, 7=Sun

mkdir -p "$BACKUP_DIR"

# Create dated tar.gz (excluding sessions which are ephemeral)
tar czf "$BACKUP_DIR/data-$DATE.tar.gz" \
  --exclude='sessions' \
  --exclude='*.tmp' \
  -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"

echo "[backup] Created $BACKUP_DIR/data-$DATE.tar.gz"

# Keep only last 7 daily backups
find "$BACKUP_DIR" -name "data-*.tar.gz" -mtime +7 -delete

echo "[backup] Cleanup done. Current backups:"
ls -lh "$BACKUP_DIR"/data-*.tar.gz 2>/dev/null
