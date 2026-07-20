#!/bin/sh
set -eu

backup_dir=${HERMES_BACKUP_DIR:-/opt/backups}
interval_seconds=${HERMES_BACKUP_INTERVAL_SECONDS:-86400}
retention_count=${HERMES_BACKUP_RETENTION_COUNT:-14}

mkdir -p "$backup_dir"

while true; do
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  archive="$backup_dir/hermes-backup-$stamp.zip"

  /opt/hermes/.venv/bin/hermes backup --output "$archive"
  sha256sum "$archive" >"$archive.sha256"

  find "$backup_dir" -maxdepth 1 -type f -name 'hermes-backup-*.zip' -print \
    | sort -r \
    | tail -n "+$((retention_count + 1))" \
    | while IFS= read -r expired; do
      rm -f -- "$expired" "$expired.sha256"
    done

  printf '%s\n' "$stamp" >"$backup_dir/last-success"
  sleep "$interval_seconds"
done
