#!/usr/bin/env bash
set -euo pipefail
umask 007

: "${EXPECTED_SYSTEM_IDENTIFIER:?required}"
: "${EXPECTED_SOURCE_MIGRATIONS_SHA256:?required}"
: "${EXPECTED_TARGET_MIGRATIONS_SHA256:?required}"
data=/var/lib/postgresql/data/pgdata
proof=/proof
postgres_pid=

stop_database() {
  if [[ -n "$postgres_pid" ]] && kill -0 "$postgres_pid" 2>/dev/null; then
    pg_ctl -D "$data" -m fast -w -t 60 stop
    wait "$postgres_pid"
  fi
}
trap stop_database EXIT
trap 'exit 143' TERM INT

[[ $(cat "$data/PG_VERSION") == 17 ]] || exit 1
control=$(pg_controldata "$data")
[[ $(awk -F ': *' '/Database system identifier:/ {print $2}' <<<"$control") == "$EXPECTED_SYSTEM_IDENTIFIER" ]] || exit 1
[[ $(awk -F ': *' '/Database cluster state:/ {print $2}' <<<"$control") == 'shut down' ]] || exit 1
[[ ! -e "$data/postmaster.pid" && ! -e "$data/standby.signal" ]] || exit 1

cat >/tmp/rehearsal.conf <<'CONFIG'
listen_addresses = '127.0.0.1'
port = 55432
unix_socket_directories = '/tmp'
hba_file = '/tmp/rehearsal-hba.conf'
ssl = off
archive_mode = off
logging_collector = off
shared_buffers = '128MB'
max_connections = 100
CONFIG
cat >/tmp/rehearsal-hba.conf <<'HBA'
local all postgres peer
host forgejo forgejo 127.0.0.1/32 scram-sha-256
HBA

# The retained clone is the only data mount. Do not load the live controller's
# TLS, archive or replication configuration in this isolated recovery process.
postgres -D "$data" -c config_file=/tmp/rehearsal.conf \
  -c listen_addresses=127.0.0.1 -c ssl=off -c archive_mode=off \
  -c primary_conninfo= -c restore_command= >"$proof/postgres.log" 2>&1 &
postgres_pid=$!
for _ in $(seq 1 60); do
  kill -0 "$postgres_pid"
  if pg_isready -h /tmp -p 55432 -U postgres -d forgejo >/dev/null; then
    break
  fi
  sleep 1
done
pg_isready -h /tmp -p 55432 -U postgres -d forgejo

sql() { psql -X -v ON_ERROR_STOP=1 -h /tmp -p 55432 -U postgres -d forgejo -Atc "$1"; }
counts_sql='SELECT (SELECT count(*) FROM "user"), (SELECT count(*) FROM repository), (SELECT count(*) FROM action_runner), (SELECT count(*) FROM public_key), (SELECT count(*) FROM deploy_key), (SELECT count(*) FROM access_token)'
identity_counts=$(sql "$counts_sql")
[[ "$identity_counts" =~ ^[0-9]+(\|[0-9]+){5}$ ]] || exit 1
printf '%s\n' "$identity_counts" >"$proof/identity-counts.before"
printf 'Snapshot identity counts: %s\n' "$identity_counts"
[[ $(sql 'SELECT version FROM version') == 305 ]] || exit 1
[[ $(sql 'SELECT id FROM forgejo_migration ORDER BY id' | sha256sum | cut -d ' ' -f 1) == "$EXPECTED_SOURCE_MIGRATIONS_SHA256" ]] || exit 1
printf 'Restored original PostgreSQL identity, base schema 305 and original Forgejo migration ledger; current snapshot identity counts captured.\n'
touch "$proof/database-ready"

for _ in $(seq 1 480); do
  [[ ! -e "$proof/migration-failed" ]] || exit 1
  kill -0 "$postgres_pid"
  if [[ -e "$proof/migration-complete" ]]; then
    break
  fi
  sleep 1
done
[[ -e "$proof/migration-complete" ]] || exit 1
sql "$counts_sql" >"$proof/identity-counts.after"
cmp "$proof/identity-counts.before" "$proof/identity-counts.after"
version=$(sql 'SELECT version FROM version')
[[ "$version" == 305 ]] || exit 1
[[ $(sql 'SELECT id FROM forgejo_migration ORDER BY id' | sha256sum | cut -d ' ' -f 1) == "$EXPECTED_TARGET_MIGRATIONS_SHA256" ]] || exit 1
sql 'SELECT pg_database_size(current_database())' >/dev/null
stop_database
postgres_pid=
[[ $(pg_controldata "$data" | awk -F ': *' '/Database cluster state:/ {print $2}') == 'shut down' ]] || exit 1
touch "$proof/database-accepted"
printf 'PASS: all 39 Forgejo release migrations applied; base schema %s and identity counts preserved; PostgreSQL shut down cleanly.\n' "$version"
