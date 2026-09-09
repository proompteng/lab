#!/usr/bin/env bash
set -euo pipefail
umask 007

: "${EXPECTED_REFS_SHA256:?required}"
proof=/proof
trap 'touch "$proof/migration-failed"' ERR

for _ in $(seq 1 90); do
  [[ ! -e "$proof/migration-failed" ]]
  if [[ -e "$proof/database-ready" ]]; then
    break
  fi
  sleep 1
done
[[ -e "$proof/database-ready" ]]
forgejo --version | grep -F '16.0.3'

references() {
  local repo count=0
  for repo in /data/git/gitea-repositories/*/*.git; do
    [[ -d "$repo" ]]
    printf '%s\n' "$repo"
    git --git-dir="$repo" show-ref
    count=$((count + 1))
  done
  [[ "$count" -eq 2 ]]
}
[[ $(references | sha256sum | cut -d ' ' -f 1) == "$EXPECTED_REFS_SHA256" ]]
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
[[ $(references | sha256sum | cut -d ' ' -f 1) == "$EXPECTED_REFS_SHA256" ]]
touch "$proof/migration-complete"
for _ in $(seq 1 90); do
  if [[ -e "$proof/database-accepted" ]]; then
    break
  fi
  sleep 1
done
[[ -e "$proof/database-accepted" ]]
printf 'PASS: Forgejo 16.0.3 migrated on isolated clones; database checks and original Git references passed.\n'
