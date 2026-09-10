#!/usr/bin/env bash
set -Eeuo pipefail

namespace=temporal
statefulset=temporal-cassandra
owner_uid=0a9b7396-7c88-4750-ba97-cf03e48e374b
pvc_uids=(310f9545-d4f6-4b8c-8bdd-a3186a109c14 74dd51e0-bc67-4713-804b-c01d60c8d06b a0bf87d0-df41-49c1-9a97-d4af83e11116)
host_ids=(49cbb919-5b4c-4489-bab3-ec01a67297fa d464e999-f072-461d-80ee-bac1b31c269c 03d74056-6b9b-4574-8757-80e130c9bae3)

fail() { printf 'Cassandra upgrade: %s\n' "$*" >&2; exit 1; }
kube() { kubectl -n "$namespace" --cache-dir=/tmp/kubectl-cache --request-timeout=30s "$@"; }
field() { kube get "$1" -o "jsonpath=$2"; }
node_exec() { kubectl -n "$namespace" --cache-dir=/tmp/kubectl-cache --request-timeout=0 exec "temporal-cassandra-$1" -c temporal-cassandra -- "${@:2}"; }

in_cluster_config() {
  local service_account=${SERVICE_ACCOUNT_DIRECTORY:-/var/run/secrets/kubernetes.io/serviceaccount}
  : "${KUBERNETES_SERVICE_HOST:?required}" "${KUBERNETES_SERVICE_PORT:?required}"
  [[ "$KUBERNETES_SERVICE_HOST" =~ ^[0-9.]+$ && "$KUBERNETES_SERVICE_PORT" =~ ^[0-9]+$ ]] || fail 'invalid in-cluster API endpoint'
  [[ -r "$service_account/token" && -r "$service_account/ca.crt" && $(cat "$service_account/namespace") == "$namespace" ]] || fail 'expected Temporal service account projection is unavailable'
  export KUBECONFIG="${TMPDIR:-/tmp}/temporal-cassandra-kubeconfig"
  umask 077
  cat >"$KUBECONFIG" <<CONFIG
apiVersion: v1
kind: Config
clusters:
- name: galactic
  cluster:
    server: "https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}"
    certificate-authority: "$service_account/ca.crt"
users:
- name: projected-service-account
  user:
    tokenFile: "$service_account/token"
contexts:
- name: temporal-upgrade
  context:
    cluster: galactic
    user: projected-service-account
    namespace: temporal
current-context: temporal-upgrade
CONFIG
}

require_parameters() {
  : "${SOURCE_IMAGE:?required}" "${TARGET_IMAGE:?required}" "${GENERATION:?required}"
  [[ "$GENERATION" =~ ^[0-9]+-v[1-9][0-9]*$ ]] || fail 'invalid backup generation'
  [[ "$SOURCE_IMAGE" == mirror.gcr.io/cassandra:* && "$TARGET_IMAGE" == mirror.gcr.io/cassandra:*@sha256:* ]] || fail 'unexpected image repository'
}

require_storage() {
  local ordinal=$1 uid phase class pv owner strategy replicas template_image
  IFS='|' read -r uid phase class pv < <(field "pvc/data-temporal-cassandra-$ordinal" '{.metadata.uid}{"|"}{.status.phase}{"|"}{.spec.storageClassName}{"|"}{.spec.volumeName}{"\n"}')
  [[ "$uid" == "${pvc_uids[ordinal]}" && "$phase" == Bound && "$class" == rook-ceph-block && "$pv" == "pvc-$uid" ]] || fail "ordinal $ordinal PVC identity or binding changed"
  IFS='|' read -r owner strategy replicas template_image < <(field "statefulset/$statefulset" '{.metadata.uid}{"|"}{.spec.updateStrategy.type}{"|"}{.spec.replicas}{"|"}{.spec.template.spec.containers[?(@.name=="temporal-cassandra")].image}{"\n"}')
  [[ "$owner" == "$owner_uid" && "$strategy" == OnDelete && "$replicas" == 3 && "$template_image" == "$required_template_image" ]] || fail 'StatefulSet identity or OnDelete strategy changed'
}

# A single API response supplies the exact Pod revision used for deletion.
read_node() {
  local ordinal=$1 state
  state=$(kube get "pod/temporal-cassandra-$ordinal" --ignore-not-found -o 'jsonpath={.metadata.uid}{"|"}{.metadata.resourceVersion}{"|"}{.metadata.ownerReferences[?(@.controller==true)].uid}{"|"}{.spec.containers[?(@.name=="temporal-cassandra")].image}{"|"}{.status.conditions[?(@.type=="Ready")].status}{"|"}{.metadata.deletionTimestamp}{"|"}{.spec.volumes[?(@.name=="data")].persistentVolumeClaim.claimName}{"\n"}') || fail 'could not read Cassandra Pod'
  IFS='|' read -r node_uid node_rv node_owner node_image node_ready node_deleting node_claim <<<"$state"
}

require_node() {
  local ordinal=$1
  require_storage "$ordinal"
  read_node "$ordinal"
  [[ "$node_uid" =~ ^[0-9a-f-]{36}$ && "$node_rv" =~ ^[0-9]+$ ]] || fail "ordinal $ordinal Pod identity missing"
  [[ "$node_owner" == "$owner_uid" && "$node_claim" == "data-temporal-cassandra-$ordinal" ]] || fail "ordinal $ordinal Pod owner or volume changed"
  [[ "$node_image" == "$SOURCE_IMAGE" || "$node_image" == "$TARGET_IMAGE" ]] || fail "ordinal $ordinal unexpected image: $node_image"
  [[ "$node_ready" == True && -z "$node_deleting" ]] || fail "ordinal $ordinal is not a stable Ready Pod"
}

ring_ready() {
  local status id ordinal netstats
  for ordinal in 0 1 2; do
    read_node "$ordinal"
    [[ "$node_ready" == True && -z "$node_deleting" ]] || return 1
    status=$(node_exec "$ordinal" nodetool status temporal) || fail "cannot read ring from ordinal $ordinal"
    [[ $(awk '$1 ~ /^[A-Z?][A-Z?]$/ {total++; if ($1 != "UN") bad++} END {print total "," (bad+0)}' <<<"$status") == 3,0 ]] || return 1
    for id in "${host_ids[@]}"; do
      [[ $(awk -v id="$id" 'index($0,id) && $1=="UN" {n++} END {print n+0}' <<<"$status") == 1 ]] || fail 'Cassandra host IDs changed'
    done
    netstats=$(node_exec "$ordinal" nodetool netstats) || fail "cannot read network state from ordinal $ordinal"
    [[ "$netstats" == *'Mode: NORMAL'* ]] || return 1
    if grep -Eq '^[[:space:]]*(Receiving|Sending)[[:space:]]+[0-9]+[[:space:]]+files' <<<"$netstats"; then return 1; fi
  done
}

wait_ring() {
  local deadline=$((SECONDS+600))
  until ring_ready; do
    (( SECONDS < deadline )) || fail 'ring did not recover to the original three UN nodes'
    sleep 10
  done
}

require_schema() {
  local versions
  versions=$(node_exec 0 nodetool describecluster | awk '/Schema versions:/ {s=1;next} s && /^[[:space:]]*[0-9a-fA-F-]+:/ {n++} END {print n+0}')
  [[ "$versions" == 1 ]] || fail 'schema has not converged'
  require_replication
}

require_replication() {
  local replication
  replication=$(node_exec 0 cqlsh 127.0.0.1 9042 -e "SELECT replication FROM system_schema.keyspaces WHERE keyspace_name='temporal';")
  [[ "$replication" == *SimpleStrategy* && "$replication" =~ replication_factor[^0-9]*3[^0-9] ]] || fail 'Temporal must retain SimpleStrategy RF3'
}

backup() {
  local ordinal snapshots
  local original_uids=()
  for ordinal in 0 1 2; do
    require_node "$ordinal"
    [[ "$node_image" == "$SOURCE_IMAGE" ]] || fail 'backup requires the unchanged source version'
    original_uids[ordinal]=$node_uid
  done
  wait_ring
  require_schema
  for ordinal in 0 1 2; do
    snapshots=$(node_exec "$ordinal" nodetool listsnapshots)
    [[ "$snapshots" != *"temporal-before-$GENERATION"* ]] || fail 'native snapshot already exists; use a new reviewed generation for a failed backup attempt'
  done
  for ordinal in 0 1 2; do
    node_exec "$ordinal" nodetool snapshot --tag "temporal-before-$GENERATION"
    node_exec "$ordinal" sync -f /var/lib/cassandra
    snapshots=$(node_exec "$ordinal" nodetool listsnapshots)
    [[ "$snapshots" == *"temporal-before-$GENERATION"* ]] || fail 'native snapshot was not recorded'
  done
  wait_ring
  for ordinal in 0 1 2; do
    require_node "$ordinal"
    [[ "$node_uid" == "${original_uids[ordinal]}" && "$node_image" == "$SOURCE_IMAGE" ]] || fail 'Pod identity changed during backup'
  done
  require_schema
  printf 'PASS: original RF3 ring flushed and snapshotted for %s.\n' "$GENERATION"
}

require_backups() {
  local ordinal completed source ready generation created bound error snapshot_class deadline snapshot_state
  completed=$(field "job/temporal-cassandra-$GENERATION-snapshot" '{.status.completionTime}')
  [[ -n "$completed" ]] || fail 'native snapshot Job did not complete'
  for ordinal in 0 1 2; do
    require_storage "$ordinal"
    deadline=$((SECONDS+900))
    while true; do
      snapshot_state=$(field "volumesnapshot/temporal-cassandra-$GENERATION-$ordinal" '{.spec.source.persistentVolumeClaimName}{"|"}{.status.readyToUse}{"|"}{.metadata.labels.temporal\.proompteng\.ai/backup-generation}{"|"}{.metadata.creationTimestamp}{"|"}{.status.boundVolumeSnapshotContentName}{"|"}{.status.error.message}{"|"}{.spec.volumeSnapshotClassName}{"\n"}') || fail 'cannot read snapshot readiness'
      IFS='|' read -r source ready generation created bound error snapshot_class <<<"$snapshot_state"
      [[ "$source" == "data-temporal-cassandra-$ordinal" && "$generation" == "$GENERATION" && "$snapshot_class" == rook-ceph-block ]] || fail 'snapshot identity does not match this stage'
      [[ -z "$error" ]] || fail "snapshot provisioning failed: $error"
      if [[ "$ready" == true && -n "$bound" ]]; then break; fi
      (( SECONDS < deadline )) || fail "ordinal $ordinal snapshot readiness timed out"
      sleep 5
    done
    require_storage "$ordinal"
    [[ "$source" == "data-temporal-cassandra-$ordinal" && "$ready" == true && "$generation" == "$GENERATION" && -n "$bound" && -z "$error" && "$snapshot_class" == rook-ceph-block ]] || fail "ordinal $ordinal snapshot is not usable for this generation"
    [[ -n "$created" ]] || fail 'volume snapshot creation time missing'
    (( $(date -d "$created" +%s) >= $(date -d "$completed" +%s) )) || fail 'volume snapshot predates the native snapshot gate'
  done
}

verify_rehearsal() {
  local ordinal address result
  require_backups
  wait_ring
  require_schema
  : "${REHEARSAL_PROOF_DIRECTORY:?required}"
  printf '%s\n' "$GENERATION" >"$REHEARSAL_PROOF_DIRECTORY/verified-generation"
  : >"$REHEARSAL_PROOF_DIRECTORY/production-cassandra-addresses"
  for ordinal in 0 1 2; do
    require_node "$ordinal"
    [[ "$node_image" == "$SOURCE_IMAGE" ]] || fail 'rehearsal requires the unchanged production source version'
    address=$(field "pod/temporal-cassandra-$ordinal" '{.status.podIP}')
    [[ "$address" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'source Pod address is unavailable'
    # The positive control uses the actual production CQL endpoint immediately
    # before the isolated engine tests denial of that same destination.
    result=$(node_exec 0 cqlsh "$address" 9042 -e 'SELECT host_id FROM system.local;')
    [[ "$result" == *"${host_ids[ordinal]}"* ]] || fail 'production CQL positive control did not return the expected host'
    printf '%s\n' "$address" >>"$REHEARSAL_PROOF_DIRECTORY/production-cassandra-addresses"
  done
  printf 'PASS: fresh native backup and all three production CQL positive controls verified for %s.\n' "$GENERATION"
}

delete_node() {
  local ordinal=$1 uid=$2 revision=$3 authorization
  local service_account=${SERVICE_ACCOUNT_DIRECTORY:-/var/run/secrets/kubernetes.io/serviceaccount}
  [[ "$ordinal" =~ ^[012]$ && "$uid" =~ ^[0-9a-f-]{36}$ && "$revision" =~ ^[0-9]+$ ]] || fail 'invalid conditional Pod deletion identity'
  authorization=$(cat "$service_account/token") || fail 'projected service account token is unavailable'
  [[ -n "$authorization" ]] || fail 'projected service account token is empty'
  printf '{"apiVersion":"v1","kind":"DeleteOptions","gracePeriodSeconds":300,"preconditions":{"uid":"%s","resourceVersion":"%s"}}' "$uid" "$revision" |
    curl --fail --silent --show-error --connect-timeout 10 --max-time 30 \
      --proto '=https' --noproxy '*' --cacert "$service_account/ca.crt" \
      --header 'Content-Type: application/json' \
      --header @<(printf 'Authorization: Bearer %s\n' "$authorization") \
      --request DELETE --data-binary @- \
      "https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}/api/v1/namespaces/$namespace/pods/temporal-cassandra-$ordinal" >/dev/null
}

rollout() {
  local ordinal old_uid expected_template deadline replacement_uid
  require_backups
  [[ -n $(field "job/temporal-cassandra-$GENERATION-rehearsal" '{.status.completionTime}') ]] || fail 'native restore rehearsal did not complete'
  expected_template=$(field "statefulset/$statefulset" '{.spec.template.spec.containers[?(@.name=="temporal-cassandra")].image}')
  [[ "$expected_template" == "$TARGET_IMAGE" ]] || fail 'StatefulSet does not select the reviewed target image'
  for ordinal in 2 1 0; do
    require_node "$ordinal"
    if [[ "$node_image" == "$TARGET_IMAGE" ]]; then wait_ring; continue; fi
    wait_ring
    require_node "$ordinal"
    old_uid=$node_uid
    require_replication
    node_exec "$ordinal" nodetool drain
    # Draining changes readiness; require identity, ownership and binding again,
    # then let the API server reject a concurrent UID/resourceVersion change.
    require_storage "$ordinal"
    read_node "$ordinal"
    [[ "$node_uid" == "$old_uid" && "$node_owner" == "$owner_uid" && "$node_claim" == "data-temporal-cassandra-$ordinal" && "$node_image" == "$SOURCE_IMAGE" && -z "$node_deleting" && "$node_rv" =~ ^[0-9]+$ ]] || fail 'Pod changed while draining; refusing deletion'
    delete_node "$ordinal" "$old_uid" "$node_rv"
    deadline=$((SECONDS+1200))
    while true; do
      read_node "$ordinal"
      if [[ -n "$node_uid" && "$node_uid" != "$old_uid" && "$node_ready" == True && -z "$node_deleting" ]]; then break; fi
      (( SECONDS < deadline )) || fail "ordinal $ordinal replacement did not become Ready"
      sleep 10
    done
    replacement_uid=$node_uid
    require_node "$ordinal"
    [[ "$node_uid" == "$replacement_uid" && "$node_image" == "$TARGET_IMAGE" ]] || fail 'replacement identity or image changed'
    wait_ring
    printf 'PASS: ordinal %s replaced %s with %s; original PVC and three-node ring retained.\n' "$ordinal" "$old_uid" "$replacement_uid"
  done
  # Mixed major versions can advertise different schemas. Convergence is a
  # final gate, never a requirement that prevents advancing the remaining nodes.
  require_schema
  for ordinal in 0 1 2; do
    require_node "$ordinal"
    [[ "$node_image" == "$TARGET_IMAGE" ]] || fail 'rollout is not complete'
    node_exec "$ordinal" nodetool upgradesstables --jobs 1
    wait_ring
  done
  require_schema
  printf 'PASS: all three nodes run %s; RF3, host IDs, PVCs and SSTable upgrade accepted.\n' "$TARGET_IMAGE"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  in_cluster_config
  require_parameters
  required_template_image=$SOURCE_IMAGE
  case "${1:-}" in
    backup) backup ;;
    verify-backups) require_backups ;;
    verify-rehearsal) verify_rehearsal ;;
    rollout) required_template_image=$TARGET_IMAGE; rollout ;;
    *) fail 'mode must be backup, verify-backups, verify-rehearsal or rollout' ;;
  esac
fi
