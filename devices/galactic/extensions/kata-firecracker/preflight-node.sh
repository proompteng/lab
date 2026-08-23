#!/usr/bin/env bash

set -euo pipefail

readonly KUBE_CONTEXT='galactic-lan'
readonly CEPH_NAMESPACE='rook-ceph'

usage() {
  echo "usage: $0 <kubernetes-node> <absolute-evidence-directory>" >&2
}

node_address() {
  case "$1" in
    talos-192-168-1-194) echo '100.100.244.141' ;;
    turin) echo '100.100.244.190' ;;
    talos-192-168-1-85) echo '100.100.244.142' ;;
    *) return 1 ;;
  esac
}

if [[ $# -ne 2 || "$2" != /* ]]; then
  usage
  exit 2
fi

readonly node="$1"
readonly evidence_dir="$2"
address="$(node_address "$node")" || {
  usage
  exit 2
}
readonly address
readonly all_addresses='100.100.244.141,100.100.244.190,100.100.244.142'

for command in jq kubectl rg talosctl; do
  if ! command -v "$command" >/dev/null; then
    echo "required command is missing: $command" >&2
    exit 1
  fi
done

install -d "$evidence_dir"

kubectl --context "$KUBE_CONTEXT" get --raw='/readyz' >"$evidence_dir/kubernetes-readyz.txt"
rg -qx 'ok' "$evidence_dir/kubernetes-readyz.txt"

kubectl --context "$KUBE_CONTEXT" get nodes -o wide >"$evidence_dir/nodes.txt"
kubectl --context "$KUBE_CONTEXT" get node "$node" -o json >"$evidence_dir/node.json"
if ! jq -e '
  .spec.unschedulable != true
  and any(.status.conditions[]; .type == "Ready" and .status == "True")
' "$evidence_dir/node.json" >/dev/null; then
  echo "$node is not both Ready and schedulable" >&2
  exit 1
fi

talosctl --nodes "$all_addresses" --endpoints "$address" etcd status \
  >"$evidence_dir/etcd-status.txt"
healthy_members="$(rg -c '[[:space:]]false[[:space:]]+3\.6\.' "$evidence_dir/etcd-status.txt" || true)"
if [[ "$healthy_members" -ne 3 ]] \
  || rg -q '[[:space:]]true[[:space:]]+3\.6\.' "$evidence_dir/etcd-status.txt"; then
  echo 'etcd does not have three healthy non-learner members' >&2
  exit 1
fi

talosctl --nodes "$address" --endpoints "$address" list /dev \
  >"$evidence_dir/devices.txt"
rg -q '[[:space:]]kvm$' "$evidence_dir/devices.txt"

kubectl --context "$KUBE_CONTEXT" -n "$CEPH_NAMESPACE" exec deploy/rook-ceph-tools -- \
  ceph status --format json >"$evidence_dir/ceph-status.json"
kubectl --context "$KUBE_CONTEXT" -n "$CEPH_NAMESPACE" exec deploy/rook-ceph-tools -- \
  ceph osd dump --format json >"$evidence_dir/ceph-osd-dump.json"

if ! jq -e '
  .osdmap.num_osds == 6
  and .osdmap.num_up_osds == 6
  and .osdmap.num_in_osds == 6
  and (.quorum_names | length) == 3
  and all(
    .pgmap.pgs_by_state[]?;
    (.state_name | test("degraded|undersized|remapped|backfill|recover|peering|inactive|down|stale|incomplete|inconsistent|unknown"; "i") | not)
  )
' "$evidence_dir/ceph-status.json" >/dev/null; then
  echo 'Ceph does not have six healthy OSDs, three monitors, and clean placement groups' >&2
  exit 1
fi

if jq -er '.flags // ""' "$evidence_dir/ceph-osd-dump.json" \
  | rg -q '(^|,)(noout|norecover|nobackfill|pause)(,|$)'; then
  echo 'Ceph has a maintenance flag that blocks a node reboot' >&2
  exit 1
fi

kubectl --context "$KUBE_CONTEXT" drain "$node" \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --dry-run=server \
  --timeout=10m >"$evidence_dir/drain-dry-run.txt"

echo "preflight passed for $node; evidence: $evidence_dir"
