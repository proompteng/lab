#!/usr/bin/env bash
set -euo pipefail
umask 007

proof=/proof
trap 'status=$?; if ((status != 0)); then touch "$proof/migration-failed"; fi' EXIT

for _ in $(seq 1 90); do
  [[ ! -e "$proof/migration-failed" ]] || exit 1
  if [[ -e "$proof/database-ready" ]]; then
    break
  fi
  sleep 1
done
[[ -e "$proof/database-ready" ]] || exit 1
forgejo --version | grep -F '16.0.3'

# Both clones come from the fresh snapshots taken after the quiesce gate.
# Capture their current references before the migration changes anything.
bash /scripts/upgrade-repository-refs.sh /data/git/gitea-repositories >"$proof/references-before"
sha256sum "$proof/references-before" >"$proof/references-before.sha256"
printf 'Snapshot repository references SHA256: %s\n' "$(cut -d ' ' -f 1 "$proof/references-before.sha256")"
shopt -s nullglob

for repo in /data/git/gitea-repositories/*/*.git; do
  git --git-dir="$repo" fsck --full --no-reflogs
done

# Preserve the cloned configuration and credential identity, changing only
# its database destination to the other container's loopback listener.
awk '
  /^\[/ { database = ($0 ~ /^\[database\][[:space:]]*$/) }
  database && /^[[:space:]]*HOST[[:space:]]*=/ {
    print "HOST = 127.0.0.1:55432"
    hosts++
    next
  }
  { print }
  END { if (hosts != 1) exit 1 }
' /data/gitea/conf/app.ini >/tmp/rehearsal.ini
chmod 600 /tmp/rehearsal.ini
forgejo --config /tmp/rehearsal.ini --work-path /data --custom-path /data/gitea migrate
forgejo --config /tmp/rehearsal.ini --work-path /data --custom-path /data/gitea \
  doctor check --run paths --run check-db-version --run check-db-consistency \
  --run authorized-keys --run synchronize-repo-heads --log-file /tmp/rehearsal-doctor.log
bash /scripts/upgrade-repository-refs.sh /data/git/gitea-repositories >"$proof/references-after"
cmp "$proof/references-before" "$proof/references-after"
touch "$proof/migration-complete"
for _ in $(seq 1 90); do
  if [[ -e "$proof/database-accepted" ]]; then
    break
  fi
  sleep 1
done
[[ -e "$proof/database-accepted" ]] || exit 1
printf 'PASS: Forgejo 16.0.3 migrated on isolated clones; database checks and original Git references passed.\n'
