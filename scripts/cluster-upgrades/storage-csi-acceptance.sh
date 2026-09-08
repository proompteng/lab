#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only post-rollout gate for the Rook Ceph-CSI node plugins. The CSI
# operator owns the DaemonSets; this helper only reads their strategy/status,
# Ceph health, VolumeAttachments, and consumers of RBD/CephFS PVs.

usage() {
  cat >&2 <<'EOF'
usage: storage-csi-acceptance.sh [--baseline PATH] [--expected-image IMAGE]

The optional baseline file contains the VolumeAttachment digest printed by a
previous run. The script never writes the cluster or the baseline file.
EOF
  exit 2
}

die() {
  echo "storage CSI acceptance: $*" >&2
  exit 1
}

context="${KUBE_CONTEXT:-galactic-lan}"
namespace="${CSI_NAMESPACE:-rook-ceph}"
expected_image="${CSI_PLUGIN_IMAGE:-quay.io/cephcsi/cephcsi:v3.17.1}"
baseline_file=

while (($# > 0)); do
  case "$1" in
    --baseline)
      (($# >= 2)) || usage
      baseline_file="$2"
      shift 2
      ;;
    --expected-image)
      (($# >= 2)) || usage
      expected_image="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

command -v kubectl >/dev/null 2>&1 || die "kubectl is required"
command -v jq >/dev/null 2>&1 || die "jq is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required"

kubectl_cmd=(kubectl --context "$context")
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/storage-csi-acceptance.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

get_json() {
  "${kubectl_cmd[@]}" "$@"
}

ceph_status="$(get_json -n "$namespace" exec deploy/rook-ceph-tools -- ceph status -f json)" \
  || die "could not read Ceph status"
jq -e '.health.status == "HEALTH_OK"' >/dev/null <<<"$ceph_status" \
  || die "Ceph health is not HEALTH_OK"

cluster_json="$(get_json -n "$namespace" get cephcluster rook-ceph -o json)" \
  || die "could not read CephCluster/rook-ceph"
jq -e '.status.cephx.csi.keyGeneration == 2' >/dev/null <<<"$cluster_json" \
  || die "Ceph-CSI key generation is not 2"

declare -a daemonsets=(
  rook-ceph.rbd.csi.ceph.com-nodeplugin
  rook-ceph.cephfs.csi.ceph.com-nodeplugin
)

for daemonset in "${daemonsets[@]}"; do
  daemonset_json="$(get_json -n "$namespace" get daemonset "$daemonset" -o json)" \
    || die "missing DaemonSet ${namespace}/${daemonset}"
  jq -e '
    .spec.updateStrategy.type == "RollingUpdate"
    and .spec.updateStrategy.rollingUpdate.maxUnavailable == 1
    and .status.desiredNumberScheduled > 0
    and .status.currentNumberScheduled == .status.desiredNumberScheduled
    and .status.updatedNumberScheduled == .status.desiredNumberScheduled
    and .status.numberAvailable == .status.desiredNumberScheduled
    and .status.numberReady == .status.desiredNumberScheduled
  ' >/dev/null <<<"$daemonset_json" \
    || die "${daemonset} is not fully ready with RollingUpdate/maxUnavailable=1"

  selector="$(jq -r '.spec.selector.matchLabels | to_entries | map(.key + "=" + .value) | join(",")' <<<"$daemonset_json")"
  [[ -n "$selector" ]] || die "${daemonset} has no selector"
  pods_json="$(get_json -n "$namespace" get pods -l "$selector" -o json)" \
    || die "could not read pods for ${daemonset}"
  jq -e --arg image "$expected_image" '
    (.items | length) > 0
    and all(.items[];
      .status.phase == "Running"
      and any(.status.conditions[]?; .type == "Ready" and .status == "True")
      and any(.spec.containers[]?; .image == $image)
    )
  ' >/dev/null <<<"$pods_json" \
    || die "${daemonset} has a missing, unready, or old-image pod"
done

volume_attachments="$(get_json get volumeattachments -o json)" \
  || die "could not read VolumeAttachments"
attachment_snapshot="$(jq -S -c '
  [.items[]
    | select(.spec.attacher == "rook-ceph.rbd.csi.ceph.com" or .spec.attacher == "rook-ceph.cephfs.csi.ceph.com")
    | {
        name: .metadata.name,
        node: .spec.nodeName,
        persistentVolume: .spec.source.persistentVolumeName,
        attached: (.status.attached // false),
        deleting: (.metadata.deletionTimestamp // null)
      }
  ] | sort_by(.name)
' <<<"$volume_attachments")"
attachment_count="$(jq 'length' <<<"$attachment_snapshot")"
jq -e 'all(.[]; .attached == true and .deleting == null)' >/dev/null <<<"$attachment_snapshot" \
  || die "a RBD/CephFS VolumeAttachment is detached or deleting"
attachment_digest="$(printf '%s\n' "$attachment_snapshot" | sha256sum | awk '{print $1}')"
if [[ -n "$baseline_file" ]]; then
  [[ -r "$baseline_file" ]] || die "baseline file is not readable: $baseline_file"
  expected_digest="$(tr -d '[:space:]' <"$baseline_file")"
  [[ "$expected_digest" == "$attachment_digest" ]] \
    || die "VolumeAttachment digest changed: baseline=${expected_digest} current=${attachment_digest}"
fi

get_json get pv -o json >"$tmp_dir/pv.json" || die "could not read PVs"
get_json get pods --all-namespaces -o json >"$tmp_dir/pods.json" || die "could not read pods"
python3 - "$tmp_dir/pv.json" "$tmp_dir/pods.json" <<'PY'
import json
import sys

pv_path, pods_path = sys.argv[1:]
with open(pv_path, encoding="utf-8") as handle:
    pvs = json.load(handle).get("items", [])
with open(pods_path, encoding="utf-8") as handle:
    pods = json.load(handle).get("items", [])

drivers = {
    "rook-ceph.rbd.csi.ceph.com",
    "rook-ceph.cephfs.csi.ceph.com",
}
claims = set()
for pv in pvs:
    csi = pv.get("spec", {}).get("csi", {})
    claim = pv.get("spec", {}).get("claimRef", {})
    if csi.get("driver") in drivers and claim.get("namespace") and claim.get("name"):
        claims.add(f"{claim['namespace']}/{claim['name']}")

consumers = []
failures = []
for pod in pods:
    metadata = pod.get("metadata", {})
    spec = pod.get("spec", {})
    status = pod.get("status", {})
    namespace = metadata.get("namespace", "")
    name = metadata.get("name", "")
    refs = {
        f"{namespace}/{volume['persistentVolumeClaim']['claimName']}"
        for volume in spec.get("volumes", [])
        if volume.get("persistentVolumeClaim", {}).get("claimName")
    }
    matched = sorted(refs & claims)
    if not matched:
        continue
    consumers.append(f"{namespace}/{name}")
    phase = status.get("phase")
    if phase == "Succeeded":
        continue
    ready = any(condition.get("type") == "Ready" and condition.get("status") == "True"
                for condition in status.get("conditions", []))
    if phase != "Running" or not ready:
        failures.append(f"{namespace}/{name} phase={phase!r} ready={ready}")

if failures:
    raise SystemExit("storage consumers are not ready: " + "; ".join(failures))
print(f"storage consumers ready: {len(consumers)}")
PY

printf 'CSI node-plugin acceptance: PASS\n'
printf 'context=%s image=%s volumeAttachments=%s attachmentDigest=%s\n' \
  "$context" "$expected_image" "$attachment_count" "$attachment_digest"
