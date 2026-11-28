#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
export LC_ALL=C
: "${REHEARSAL_VERSION:?}" "${EXPECTED_VERSION:?}" "${NATIVE_SNAPSHOT_FILE:?}" "${NATIVE_SNAPSHOT_SHA256:?}" "${CANARY_VALUE:?}"
[[ "$REHEARSAL_VERSION" == v25_12 || "$REHEARSAL_VERSION" == v26_8 ]]
base=/fixture/keeper-v2
data="$base/native"
proof="/proof/keeper-v2/$REHEARSAL_VERSION"
mkdir -p /proof/keeper-v2
mkdir "$proof"
wait_for_control() {
  local path=$1
  for ((attempt=0; attempt<900; attempt++)); do
    if [[ -f "$path" ]]; then return 0; fi
    sleep 2
  done
  printf 'Runtime control did not arrive: %s\n' "$path" >&2
  return 1
}
printf 'waiting for live endpoint controls: %s\n' "$REHEARSAL_VERSION"
wait_for_control "$proof/runtime-before.epoch"
before_epoch=$(cat "$proof/runtime-before.epoch")
[[ "$before_epoch" =~ ^[0-9]+$ && $(( $(date +%s) - before_epoch )) -ge 0 && $(( $(date +%s) - before_epoch )) -le 30 ]]
mapfile -t endpoints < "$proof/runtime-targets.txt"
[[ "${#endpoints[@]}" == 6 ]]
for endpoint in "${endpoints[@]}"; do
  host=${endpoint%:*}; port=${endpoint##*:}
  [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ && "$port" =~ ^[0-9]+$ ]]
  error="$proof/probe-$host-$port.stderr"
  probe_started=$(date +%s)
  if timeout 5 bash -c "exec 3<>/dev/tcp/$host/$port" 2>"$error"; then
    printf 'Production endpoint is reachable: %s\n' "$endpoint" >&2
    exit 1
  else
    status=$?
    elapsed=$(( $(date +%s) - probe_started ))
    if [[ ( "$status" == 124 || "$status" == 143 ) && "$elapsed" -ge 5 ]]; then outcome=TIMED_OUT
    elif [[ "$status" == 1 ]] && grep -Fq "/dev/tcp/$host/$port: Connection refused" "$error"; then outcome=REJECTED
    else cat "$error" >&2; exit 1
    fi
  fi
  printf '{"endpoint":"%s","exitCode":%s,"outcome":"%s","elapsedSeconds":%s}\n' "$endpoint" "$status" "$outcome" "$elapsed" >> "$proof/isolation-probes.jsonl"
  printf '%s\tDENIED\n' "$endpoint" >> "$proof/isolation.tsv"
done
wait_for_control "$proof/runtime-after.epoch"
after_epoch=$(cat "$proof/runtime-after.epoch")
[[ "$after_epoch" =~ ^[0-9]+$ && $(( after_epoch - before_epoch )) -ge 0 && $(( after_epoch - before_epoch )) -le 90 ]]
printf '%s  %s\n' "$NATIVE_SNAPSHOT_SHA256" "/source/coordination/snapshots/$NATIVE_SNAPSHOT_FILE" | sha256sum -c -
if [[ "$REHEARSAL_VERSION" == v25_12 ]]; then
  mkdir "$base"
  mkdir "$data"
  cp -R /source/coordination "$data/"
  cp /source/uuid /source/state "$data/"
  (cd /source && find coordination -type f -exec sha256sum {} +; sha256sum uuid state) | sort > "$proof/source-files.sha256"
  (cd "$data" && find coordination -type f -exec sha256sum {} +; sha256sum uuid state) | sort > "$proof/copied-files.sha256"
  cmp "$proof/source-files.sha256" "$proof/copied-files.sha256"
else
  [[ -d "$data/coordination" && "$(cat /proof/keeper-v2/v25_12/process-exit)" == 0 ]]
fi
cat > "$base/config.xml" <<EOF
<clickhouse>
  <path>$data/</path><logger><level>warning</level><console>1</console></logger>
  <listen_host>127.0.0.1</listen_host>
  <keeper_server>
    <tcp_port>2181</tcp_port><server_id>0</server_id>
    <storage_path>$data</storage_path>
    <log_storage_path>$data/coordination/logs</log_storage_path>
    <snapshot_storage_path>$data/coordination/snapshots</snapshot_storage_path>
    <four_letter_word_white_list>conf,cons,crst,envi,ruok,srst,srvr,stat,wchs,dirs,mntr,isro</four_letter_word_white_list>
    <max_memory_usage_soft_limit>805306368</max_memory_usage_soft_limit>
    <coordination_settings><operation_timeout_ms>60000</operation_timeout_ms>
      <session_timeout_ms>300000</session_timeout_ms><startup_timeout>180000</startup_timeout>
      <async_replication>true</async_replication><use_xid_64>true</use_xid_64>
      <force_sync>true</force_sync><compress_logs>false</compress_logs>
      <latest_logs_cache_size_threshold>134217728</latest_logs_cache_size_threshold>
      <commit_logs_cache_size_threshold>67108864</commit_logs_cache_size_threshold>
    </coordination_settings>
    <raft_configuration><server><id>0</id><hostname>chk-torghut-keeper-default-0-0</hostname><port>9444</port></server></raft_configuration>
  </keeper_server>
</clickhouse>
EOF
keeper_pid=''
cleanup() {
  result=$?
  trap - EXIT
  if [[ -n "$keeper_pid" ]] && kill -0 "$keeper_pid" 2>/dev/null; then
    kill -TERM "$keeper_pid"
    if ! wait "$keeper_pid"; then result=1; fi
  fi
  printf '%s\n' "$result" > "$proof/process-exit"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
clickhouse-keeper --config-file "$base/config.xml" > "$proof/keeper.log" 2>&1 &
keeper_pid=$!
query() {
  local command=$1 output=$2
  clickhouse-keeper keeper-client --host 127.0.0.1 --port 2181 --operation-timeout 60 --query "$command" > "$output" 2>"$output.stderr"
  if [[ -s "$output.stderr" ]] || grep -Eq '^(Syntax error:|Code: [0-9]+\.|Error:)' "$output"; then
    cat "$output.stderr" >&2
    head -c 1000 "$output" >&2
    return 1
  fi
}
ready=false
for ((attempt=0; attempt<180; attempt++)); do
  kill -0 "$keeper_pid"
  if query 'flwc ruok' "$proof/ruok" && [[ "$(cat "$proof/ruok")" == imok ]]; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]]
for ((attempt=0; attempt<180; attempt++)); do
  query 'flwc mntr' "$proof/mntr.txt"
  if [[ "$(awk '$1=="zk_ephemerals_count" {print $2}' "$proof/mntr.txt")" == 0 ]]; then break; fi
  sleep 2
done
[[ "$(awk '$1=="zk_ephemerals_count" {print $2}' "$proof/mntr.txt")" == 0 ]]
grep -Fq "v$EXPECTED_VERSION-" "$proof/mntr.txt"
grep -Eq '^zk_server_state[[:space:]]+(leader|standalone)$' "$proof/mntr.txt"
canary=/upgrade_native_20260910_v1
if [[ "$REHEARSAL_VERSION" == v25_12 ]]; then
  query "exists '$canary'" "$proof/canary-exists-before"
  [[ "$(cat "$proof/canary-exists-before")" == 0 ]]
  query "create '$canary' '$CANARY_VALUE'" "$proof/canary-create"
fi
query "get '$canary'" "$proof/canary-value"
[[ "$(cat "$proof/canary-value")" == "$CANARY_VALUE" ]]
query "get_stat '$canary'" "$proof/canary-stat"
query "get_acl '$canary'" "$proof/canary-acl"
query "get_stat '/'" "$proof/root-stat"
query "get_all_children_number '/'" "$proof/all-children"
query "get_all_children_number '/clickhouse'" "$proof/clickhouse-children"
query "ls '/clickhouse'" "$proof/clickhouse-root"
query 'flwc conf' "$proof/conf.txt"
query 'flwc mntr' "$proof/mntr.txt"
sha256sum "$data/uuid" > "$proof/uuid.sha256"
kill -TERM "$keeper_pid"
wait "$keeper_pid"
keeper_pid=''
printf '0\n' > "$proof/keeper-exit"
printf '%s native recovery completed\n' "$REHEARSAL_VERSION"
