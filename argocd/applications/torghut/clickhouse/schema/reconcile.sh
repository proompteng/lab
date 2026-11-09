#!/usr/bin/env bash
set -euo pipefail

directory="$(cd "$(dirname "$0")" && pwd)"
primary="${1:?ClickHouse service host is required}"
client=(clickhouse-client --port 9000 --user "${CLICKHOUSE_USERNAME:?}"
  --password "${CLICKHOUSE_PASSWORD:?}" --connect_timeout 5 --send_timeout 30)

query() {
  local host="$1"
  shift
  "${client[@]}" --host "$host" --query_id "torghut-schema-${BASHPID}-${RANDOM}" "$@"
}

deadline=$((SECONDS + 120))
until hosts_output="$(query "$primary" --receive_timeout 15 --query \
  "SELECT host_name FROM system.clusters WHERE cluster = 'default' ORDER BY shard_num, replica_num FORMAT TSVRaw")"; do
  if (( SECONDS >= deadline )); then
    echo 'ClickHouse replica discovery did not become available' >&2
    exit 1
  fi
  sleep 3
done
mapfile -t hosts <<< "$hosts_output"
if [[ ${#hosts[@]} != 2 || -z "${hosts[0]}" || -z "${hosts[1]}" || "${hosts[0]}" == "${hosts[1]}" ]]; then
  echo 'Expected the two distinct ClickHouse replicas in cluster default' >&2
  exit 1
fi

verify() {
  query "$1" --readonly 1 --max_execution_time 30 --receive_timeout 60 \
    --multiquery --queries-file "$directory/$2.verify.sql"
}

for schema in adjusted-daily intraday-bars intraday-features historical-datasets; do
  for host in "${hosts[@]}"; do
    echo "Checking $schema on $host"
    if verify "$host" "$schema"; then
      echo "Verified $schema on $host; no DDL needed"
      continue
    fi
    # Address each replica directly: ON CLUSTER enqueues even already-applied DDL in Keeper.
    echo "Applying $schema on $host"
    query "$host" --max_execution_time 300 --receive_timeout 360 \
      --multiquery --queries-file "$directory/$schema.sql"
    verify "$host" "$schema"
  done
done
echo 'All Signal schemas verified on both ClickHouse replicas'
