#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
export LC_ALL=C

: "${REHEARSAL_VERSION:?}" "${EXPECTED_VERSION:?}" "${REPLICA:?}"
: "${BACKUP_DIRECTORY:?}" "${BACKUP_MANIFEST_SHA256:?}" "${COMPATIBILITY:?}"
[[ "$REHEARSAL_VERSION" =~ ^v[0-9]+_[0-9]+$ ]]
[[ "$REPLICA" =~ ^[01]$ ]]
[[ "$BACKUP_DIRECTORY" =~ ^upgrade-20260910-v1-replica-[01]$ ]]
generation=${REHEARSAL_GENERATION:-v3}
[[ "$generation" =~ ^v[0-9]+$ ]]
fixture="/fixture/$generation/$REHEARSAL_VERSION"
proof="/proof/$generation/$REHEARSAL_VERSION"
backup="/source/backups/$BACKUP_DIRECTORY"
mkdir -p "/fixture/$generation" "/proof/$generation"
mkdir "$proof"
mkdir "$fixture"
mkdir -p "$fixture"/{data,tmp,user_files,access,keeper/log,keeper/snapshots}
wait_for_control() {
  local file=$1
  for ((attempt=0; attempt<1800; attempt++)); do
    if [[ -f "$file" ]]; then return 0; fi
    sleep 2
  done
  printf 'Runtime isolation control did not arrive: %s\n' "$file" >&2
  return 1
}
printf 'waiting for live endpoint controls: %s replica %s\n' "$REHEARSAL_VERSION" "$REPLICA"
wait_for_control "$proof/runtime-before.epoch"
control_epoch=$(cat "$proof/runtime-before.epoch")
[[ "$control_epoch" =~ ^[0-9]+$ && $(( $(date +%s) - control_epoch )) -ge 0 && $(( $(date +%s) - control_epoch )) -le 30 ]]
mapfile -t production_targets < "$proof/runtime-targets.txt"
[[ "${#production_targets[@]}" == 5 ]]
for endpoint in "${production_targets[@]}"; do
  host=${endpoint%:*}
  port=${endpoint##*:}
  [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ && "$port" =~ ^[0-9]+$ ]]
  error="$proof/probe-$host-$port.stderr"
  if timeout 5 bash -c "exec 3<>/dev/tcp/$host/$port" 2>"$error"; then
    printf 'Production endpoint is reachable: %s\n' "$endpoint" >&2
    exit 1
  else
    result=$?
    if [[ "$result" == 124 ]]; then
      outcome=TIMED_OUT
    elif [[ "$result" == 1 ]] && grep -Fq "/dev/tcp/$host/$port: Connection refused" "$error"; then
      outcome=REJECTED
    else
      printf 'Unclassified isolation failure: %s status %s\n' "$endpoint" "$result" >&2
      cat "$error" >&2
      exit 1
    fi
  fi
  printf '{"endpoint":"%s","exitCode":%s,"outcome":"%s"}\n' "$endpoint" "$result" "$outcome" >> "$proof/isolation-probes.jsonl"
  printf '%s\tDENIED\n' "$endpoint" >> "$proof/isolation.tsv"
done
wait_for_control "$proof/runtime-after.epoch"
after_epoch=$(cat "$proof/runtime-after.epoch")
[[ "$after_epoch" =~ ^[0-9]+$ && $(( after_epoch - control_epoch )) -ge 0 && $(( after_epoch - control_epoch )) -le 90 ]]
printf '%s  %s\n' "$BACKUP_MANIFEST_SHA256" "$backup/.backup" | sha256sum --check --strict
[[ "$(df --output=avail -B1 /fixture | tail -1 | tr -d ' ')" -ge 21474836480 ]]
server_pid=''
keeper_pid=''
cleanup() {
  result=$?
  trap - EXIT
  if [[ "$result" != 0 ]]; then
    tail -c 12000 "$proof/server.log" "$proof/keeper.log" >&2 || true
  fi
  for child in "$server_pid" "$keeper_pid"; do
    if [[ -n "$child" ]] && kill -0 "$child" 2>/dev/null; then
      kill -TERM "$child"
      if ! wait "$child"; then result=1; fi
    fi
  done
  printf '%s\n' "$result" > "$proof/process-exit"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
cat > "$fixture/config.xml" <<EOF
<clickhouse>
  <logger><level>warning</level><console>1</console></logger>
  <path>$fixture/data/</path><tmp_path>$fixture/tmp/</tmp_path>
  <user_files_path>$fixture/user_files/</user_files_path><access_control_path>$fixture/access/</access_control_path>
  <listen_host>127.0.0.1</listen_host><tcp_port>9000</tcp_port><http_port>8123</http_port>
  <interserver_http_host>127.0.0.1</interserver_http_host><interserver_http_port>9009</interserver_http_port>
  <interserver_listen_host>127.0.0.1</interserver_listen_host>
  <max_server_memory_usage>4294967296</max_server_memory_usage>
  <background_pool_size>4</background_pool_size><background_schedule_pool_size>16</background_schedule_pool_size>
  <merge_tree><number_of_free_entries_in_pool_to_execute_mutation>2</number_of_free_entries_in_pool_to_execute_mutation>
    <number_of_free_entries_in_pool_to_lower_max_size_of_merge>2</number_of_free_entries_in_pool_to_lower_max_size_of_merge>
    <number_of_free_entries_in_pool_to_execute_optimize_entire_partition>2</number_of_free_entries_in_pool_to_execute_optimize_entire_partition>
  </merge_tree>
  <profiles><default><max_threads>2</max_threads><max_memory_usage>3221225472</max_memory_usage>
    <compatibility>$COMPATIBILITY</compatibility><output_format_json_quote_64bit_integers>1</output_format_json_quote_64bit_integers>
    <async_insert>0</async_insert></default></profiles>
  <users><default><password></password><networks><ip>127.0.0.1</ip><ip>::1</ip></networks>
    <profile>default</profile><quota>default</quota></default></users><quotas><default/></quotas>
  <backups><allowed_path>/source/backups</allowed_path></backups>
  <macros><cluster>torghut-clickhouse</cluster><shard>0</shard><replica>restore-$REPLICA</replica></macros>
  <zookeeper><node><host>127.0.0.1</host><port>2181</port></node></zookeeper>
</clickhouse>
EOF
cat > "$fixture/keeper.xml" <<EOF
<clickhouse>
  <logger><level>warning</level><console>1</console></logger><listen_host>127.0.0.1</listen_host>
  <keeper_server><tcp_port>2181</tcp_port><server_id>1</server_id>
    <log_storage_path>$fixture/keeper/log</log_storage_path><snapshot_storage_path>$fixture/keeper/snapshots</snapshot_storage_path>
    <coordination_settings><operation_timeout_ms>10000</operation_timeout_ms><session_timeout_ms>30000</session_timeout_ms></coordination_settings>
    <raft_configuration><server><id>1</id><hostname>127.0.0.1</hostname><port>9234</port></server></raft_configuration>
  </keeper_server>
</clickhouse>
EOF
clickhouse keeper --config-file="$fixture/keeper.xml" > "$proof/keeper.log" 2>&1 &
keeper_pid=$!
clickhouse-server --config-file="$fixture/config.xml" > "$proof/server.log" 2>&1 &
server_pid=$!
sql() { clickhouse-client --host 127.0.0.1 --query "$1" --format "${2:-JSONEachRow}"; }
ready=false
for ((attempt=0; attempt<90; attempt++)); do
  kill -0 "$server_pid"
  kill -0 "$keeper_pid"
  if sql 'SELECT version()' TSVRaw > "$proof/version" 2>/dev/null &&
    sql "SELECT count() FROM system.zookeeper WHERE path='/'" TSVRaw > "$proof/keeper-ready.tsv" 2>"$proof/keeper-ready.stderr"; then
    ready=true
    break
  fi
  sleep 2
done
reported_version=$(cat "$proof/version")
[[ "$ready" == true && "${reported_version%.altinitystable}" == "$EXPECTED_VERSION" ]]
restore="RESTORE DATABASE default, DATABASE signal, DATABASE torghut FROM File('$backup')"
sql "$restore SETTINGS structure_only=1" > "$proof/structure-restore.jsonl"
sql "SELECT database,name,engine FROM system.tables WHERE database IN ('default','signal','torghut') ORDER BY database,name" TSVRaw > "$proof/tables.tsv"
cmp /scripts/expected-tables.tsv "$proof/tables.tsv"
while IFS=$'\t' read -r database table engine; do
  [[ "$database" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && "$table" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
  if [[ "$engine" == *MergeTree ]]; then
    sql "SYSTEM STOP MERGES \`$database\`.\`$table\`"
    sql "SYSTEM STOP TTL MERGES \`$database\`.\`$table\`"
  fi
done < "$proof/tables.tsv"
replicas_ready=false
for ((attempt=0; attempt<90; attempt++)); do
  kill -0 "$server_pid"
  kill -0 "$keeper_pid"
  if [[ "$(sql "SELECT count()=11 AND countIf(is_readonly OR is_session_expired)=0 FROM system.replicas" TSVRaw)" == 1 ]]; then
    replicas_ready=true
    break
  fi
  sleep 2
done
[[ "$replicas_ready" == true ]]
sql "$restore" > "$proof/data-restore.jsonl"
sql "SELECT database,name,engine,engine_full,uuid FROM system.tables WHERE database IN ('default','signal','torghut') ORDER BY database,name" > "$proof/tables.jsonl"
sql "SELECT database,table,name,type,default_kind,default_expression,compression_codec FROM system.columns WHERE database IN ('default','signal','torghut') ORDER BY database,table,position" > "$proof/columns.jsonl"
while IFS=$'\t' read -r database table engine; do
  relation="\`$database\`.\`$table\`"
  if [[ "$engine" == *MergeTree ]]; then
    sql "CHECK TABLE $relation SETTINGS check_query_single_value_result=1" > "$proof/check-$database-$table.jsonl"
    lanes=''
    for ((lane=0; lane<4; lane++)); do
      expression="reinterpretAsUInt64(substring(h,$((lane*8+1)),8))"
      lanes+=",toString(sumWithOverflow($expression)) AS sum$lane,toString(groupBitXor($expression)) AS xor$lane"
    done
    sql "SELECT count() AS rows$lanes FROM (SELECT SHA256(toJSONString(tuple(*))) AS h FROM $relation)" > "$proof/fingerprint-$database-$table.jsonl"
    printf 'fingerprinted %s %s.%s\n' "$REHEARSAL_VERSION" "$database" "$table"
  elif [[ "$engine" == View ]]; then
    sql "SELECT count() AS rows FROM $relation" > "$proof/view-$database-$table.jsonl"
  fi
done < "$proof/tables.tsv"
sql "SELECT database,table,is_readonly,is_session_expired,queue_size,lost_part_count FROM system.replicas ORDER BY database,table" > "$proof/replicas.jsonl"
kill -TERM "$server_pid"
wait "$server_pid"
server_pid=''
printf '0\n' > "$proof/server-exit"
kill -TERM "$keeper_pid"
wait "$keeper_pid"
keeper_pid=''
printf '0\n' > "$proof/keeper-exit"
printf 'native restore and fingerprint complete: %s replica %s\n' "$REHEARSAL_VERSION" "$REPLICA"
