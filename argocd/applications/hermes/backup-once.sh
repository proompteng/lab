#!/bin/sh
set -eu

backup_dir=${HERMES_BACKUP_DIR:-/opt/backups}
retention_count=${HERMES_BACKUP_RETENTION_COUNT:-14}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive_name="hermes-backup-$stamp.zip"
archive="$backup_dir/$archive_name"
pending_archive="$backup_dir/.hermes-backup-$stamp.zip"
pending_checksum="$archive.sha256.pending"
pending_marker="$backup_dir/.last-success.pending"
completed=false

cleanup() {
  rm -f -- "$pending_archive" "$pending_checksum" "$pending_marker"
  if [ "$completed" != true ]; then
    rm -f -- "$archive" "$archive.sha256"
  fi
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$backup_dir" "${HOME:-/tmp/home}"
/opt/hermes/.venv/bin/hermes backup --output "$pending_archive"
pending_digest=$(sha256sum "$pending_archive")
expected_digest=${pending_digest%% *}
printf '%s  %s\n' "$expected_digest" "$archive_name" >"$pending_checksum"
printf '%s  %s\n' "$expected_digest" "$pending_archive" | sha256sum -c -
mv -- "$pending_checksum" "$archive.sha256"
mv -- "$pending_archive" "$archive"
(cd "$backup_dir" && sha256sum -c "$archive_name.sha256")

find "$backup_dir" -maxdepth 1 -type f -name 'hermes-backup-*.zip' -print \
  | sort -r \
  | tail -n "+$((retention_count + 1))" \
  | while IFS= read -r expired; do
    rm -f -- "$expired" "$expired.sha256"
  done

printf '%s\n' "$stamp" >"$pending_marker"
mv -- "$pending_marker" "$backup_dir/last-success"
completed=true
printf 'Hermes backup completed and verified: %s\n' "$(basename "$archive")"
