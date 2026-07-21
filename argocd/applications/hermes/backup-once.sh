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
if backup_output=$(/opt/hermes/.venv/bin/hermes backup --output "$pending_archive" 2>&1); then
  printf '%s\n' "$backup_output"
else
  backup_status=$?
  printf '%s\n' "$backup_output" >&2
  exit "$backup_status"
fi
case "$backup_output" in
  *"SQLite safe copy failed"*|*"Raw copy also failed"*|*"Warnings ("*)
    echo 'Hermes backup reported an unsafe or incomplete database copy' >&2
    exit 1
    ;;
esac
unset backup_output backup_status

/opt/hermes/.venv/bin/python - "$pending_archive" <<'PY'
import shutil
import sqlite3
import sys
import tempfile
import zipfile

archive = sys.argv[1]
database_count = 0
with zipfile.ZipFile(archive) as backup:
    corrupt_entry = backup.testzip()
    if corrupt_entry is not None:
        raise RuntimeError(f"corrupt zip entry: {corrupt_entry}")
    for entry in (candidate for candidate in backup.infolist() if candidate.filename.endswith(".db")):
        with tempfile.NamedTemporaryFile(dir="/tmp", suffix=".db") as extracted:
            with backup.open(entry) as source:
                shutil.copyfileobj(source, extracted)
            extracted.flush()
            connection = sqlite3.connect(f"file:{extracted.name}?mode=ro", uri=True)
            results = [row[0] for row in connection.execute("PRAGMA quick_check")]
            connection.close()
            if results != ["ok"]:
                raise RuntimeError(f"SQLite integrity check failed: {entry.filename}")
        database_count += 1
if database_count == 0:
    raise RuntimeError("backup contains no SQLite databases")
print(f"Verified {database_count} SQLite database snapshot(s)")
PY

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
