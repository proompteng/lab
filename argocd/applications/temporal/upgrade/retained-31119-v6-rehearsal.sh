#!/usr/bin/env bash
set -Eeuo pipefail
: "${EXPECTED_VERSION:?required}" "${REHEARSAL_PHASE:?required}"
[[ "$REHEARSAL_PHASE" == restore || "$REHEARSAL_PHASE" == source || "$REHEARSAL_PHASE" == target ]] || exit 1
[[ "$EXPECTED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
python_command=$(command -v python3 || command -v python2 || command -v python) || {
  printf 'Cassandra rehearsal requires a bundled Python interpreter.\n' >&2
  exit 1
}
# The token-bearing init container verifies fresh native backups and probes
# production CQL successfully. Engine containers never mount that token. Policy
# allows only API metadata access, and the actual production data paths must be
# denied before either engine opens its clone.
: "${GENERATION:?required}"
"$python_command" /scripts/verify-rehearsal-network.py
if [[ "$REHEARSAL_PHASE" == restore ]]; then
  "$python_command" /scripts/restore-native-snapshot.py
  exit 0
fi
[[ $(cat /proof/native-snapshot-generation) == "$GENERATION" ]] || {
  printf 'Cassandra engine requires a completed native snapshot restore.\n' >&2
  exit 1
}
engine_pid=
stop_engine() {
  if [[ -n "$engine_pid" ]] && kill -0 "$engine_pid" 2>/dev/null; then
    nodetool drain || return $?
    kill -TERM "$engine_pid"
    local status=0
    wait "$engine_pid" || status=$?
    [[ "$status" == 0 || "$status" == 143 ]] || return "$status"
    engine_pid=
  fi
}
on_exit() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then tail -n 40 "/proof/$REHEARSAL_PHASE-engine.log" >&2 || true; fi
  if ! stop_engine; then status=1; fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 143' TERM INT

# The only data mount contains the verified native snapshot restore. The official entrypoint supplies
# version-specific defaults while all listeners/seeds remain on loopback.
export CASSANDRA_LISTEN_ADDRESS=127.0.0.1 CASSANDRA_BROADCAST_ADDRESS=127.0.0.1
export CASSANDRA_RPC_ADDRESS=127.0.0.1 CASSANDRA_BROADCAST_RPC_ADDRESS=127.0.0.1
export CASSANDRA_SEEDS=127.0.0.1 CASSANDRA_CLUSTER_NAME=cassandra CASSANDRA_ENDPOINT_SNITCH=SimpleSnitch
export JVM_OPTS="${JVM_OPTS:-} -Dcassandra.load_ring_state=false"
/usr/local/bin/docker-entrypoint.sh cassandra -f >"/proof/$REHEARSAL_PHASE-engine.log" 2>&1 &
engine_pid=$!
ready=false
for _ in $(seq 1 180); do
  kill -0 "$engine_pid"
  if cqlsh 127.0.0.1 9042 -e 'SELECT release_version FROM system.local;' >"/proof/$REHEARSAL_PHASE-version" 2>/dev/null; then ready=true; break; fi
  sleep 5
done
[[ "$ready" == true ]] || exit 1
grep -Fq "$EXPECTED_VERSION" "/proof/$REHEARSAL_PHASE-version"
cqlsh 127.0.0.1 9042 -e 'SELECT host_id FROM system.local;' | grep -Fq 49cbb919-5b4c-4489-bab3-ec01a67297fa
nodetool disableautocompaction temporal
for table in namespaces namespaces_by_id schema_version; do
  cqlsh 127.0.0.1 9042 -e "CONSISTENCY ONE; SELECT JSON * FROM temporal.$table;" |
    "$python_command" /scripts/canonicalize-cql.py >"/proof/$REHEARSAL_PHASE-$table.sha256"
  if [[ "$REHEARSAL_PHASE" == target ]]; then
    cmp "/proof/source-$table.sha256" "/proof/target-$table.sha256"
  fi
done
if [[ "$REHEARSAL_PHASE" == target ]]; then nodetool upgradesstables --jobs 1; fi
nodetool verify --extended-verify temporal
stop_engine
printf 'PASS: %s Cassandra %s recovered the original host and Temporal namespace/schema records; native SSTable verification passed and engine stopped cleanly.\n' "$REHEARSAL_PHASE" "$EXPECTED_VERSION"
