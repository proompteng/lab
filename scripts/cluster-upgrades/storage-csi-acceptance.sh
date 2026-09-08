#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only post-rollout gate for the Rook Ceph-CSI node plugins. The CSI
# operator owns the DaemonSets; this helper only reads their strategy/status,
# Ceph health, VolumeAttachments, and consumers of RBD/CephFS PVs.

usage() {
  cat >&2 <<'EOF'
usage: storage-csi-acceptance.sh [--baseline PATH] [--expected-image IMAGE] [--functional-only]

The optional baseline file contains the VolumeAttachment digest printed by a
previous run. The script never writes the cluster or the baseline file.

By default, the script requires Ceph HEALTH_OK. --functional-only still runs
all functional checks but allows only the approved AES compatibility
warnings; it reports security completion as INCOMPLETE and exits nonzero for
unknown warnings, mutes, or any functional failure.
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
functional_only=0

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
    --functional-only)
      functional_only=1
      shift
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

record_failure() {
  failures+=("$*")
}

declare -a failures=()

ceph_status=
if ! ceph_status="$(get_json -n "$namespace" exec deploy/rook-ceph-tools -- ceph status -f json)"; then
  record_failure "could not read Ceph status"
fi

health_status=UNKNOWN
health_check_ids=
health_mute_count=0
muted_check_count=0
approved_warning_posture=0
security_complete=0
security_gate_failure=
approved_warning_ids='["AUTH_INSECURE_CLIENT_KEY_TYPE","AUTH_INSECURE_KEYS_ALLOWED","AUTH_INSECURE_KEYS_CREATABLE","AUTH_INSECURE_ROTATING_SERVICE_KEY_TYPE"]'

if [[ -n "$ceph_status" ]]; then
  if ! health_status="$(jq -r '.health.status // "UNKNOWN"' <<<"$ceph_status")"; then
    record_failure "Ceph status is not valid JSON"
    health_status=UNKNOWN
  fi
  if ! health_check_ids="$(jq -r '((.health.checks // {}) | keys | sort | join(","))' <<<"$ceph_status")"; then
    record_failure "Ceph health checks are not readable"
    health_check_ids=unknown
  fi
  if ! health_mute_count="$(jq -r '((.health.mutes // []) | length)' <<<"$ceph_status")"; then
    record_failure "Ceph health mutes are not readable"
    health_mute_count=0
  fi
  if ! muted_check_count="$(jq -r '[(.health.checks // {}) | to_entries[] | select(.value.muted == true)] | length' <<<"$ceph_status")"; then
    record_failure "Ceph health check mute state is not readable"
    muted_check_count=0
  fi
  if jq -e --argjson allowed "$approved_warning_ids" '
    .health.status == "HEALTH_WARN"
    and ((.health.checks // {}) | length) > 0
    and (((.health.checks // {}) | keys) - $allowed | length) == 0
    and all((.health.checks // {})[];
      (.severity // "") == "HEALTH_WARN"
      and (.muted // false) == false
    )
  ' >/dev/null <<<"$ceph_status"; then
    approved_warning_posture=1
  fi
else
  security_gate_failure="Ceph health is unavailable"
fi

printf 'Ceph health observed: %s checks=%s mutes=%s mutedChecks=%s\n' \
  "$health_status" "${health_check_ids:-none}" "$health_mute_count" "$muted_check_count" >&2

if [[ -n "$ceph_status" ]]; then
  if ((health_mute_count > 0 || muted_check_count > 0)); then
    security_gate_failure="Ceph health has ${health_mute_count} mute(s) and ${muted_check_count} muted check(s)"
  elif [[ "$health_status" == "HEALTH_OK" ]]; then
    security_complete=1
  elif ((functional_only == 1)) && [[ "$health_status" == "HEALTH_WARN" && "$approved_warning_posture" == 1 ]]; then
    :
  else
    security_gate_failure="Ceph health is ${health_status} (checks=${health_check_ids:-none})"
  fi
fi

cluster_json=
if cluster_json="$(get_json -n "$namespace" get cephcluster rook-ceph -o json)"; then
  if ! jq -e '
    .status.phase == "Ready"
    and .spec.security.cephx.csi.keyGeneration == 3
    and .status.cephx.csi.keyGeneration == 3
    and .spec.security.cephx.csi.keyType == "aes256k"
    and .status.cephx.csi.keyType == "aes256k"
  ' >/dev/null <<<"$cluster_json"; then
    record_failure "CephCluster is not Ready with CSI key generation 3 and AES256K key type"
  fi
else
  record_failure "could not read CephCluster/rook-ceph"
fi

quorum_json=
if quorum_json="$(get_json -n "$namespace" exec deploy/rook-ceph-tools -- ceph quorum_status -f json)"; then
  if ! jq -e '
    (.quorate // true) == true
    and (.quorum | length) == 3
    and (.quorum_names | length) == 3
  ' >/dev/null <<<"$quorum_json"; then
    record_failure "Ceph monitor quorum is not healthy with three members"
  fi
else
  record_failure "could not read Ceph monitor quorum"
fi

osd_json=
if osd_json="$(get_json -n "$namespace" exec deploy/rook-ceph-tools -- ceph osd stat -f json)"; then
  if ! jq -e '
    .num_osds == 6
    and .num_up_osds == 6
    and .num_in_osds == 6
  ' >/dev/null <<<"$osd_json"; then
    record_failure "Ceph OSD health is not 6 total, 6 up, and 6 in"
  fi
else
  record_failure "could not read Ceph OSD status"
fi

pg_json=
if pg_json="$(get_json -n "$namespace" exec deploy/rook-ceph-tools -- ceph pg stat -f json)"; then
  if ! jq -e '
    .pg_ready == true
    and (.pg_summary.num_pgs // 0) > 0
    and ([.pg_summary.num_pg_by_state[]? | .num] | add) == .pg_summary.num_pgs
    and all(.pg_summary.num_pg_by_state[]?; (.name | startswith("active+clean")))
  ' >/dev/null <<<"$pg_json"; then
    record_failure "Ceph PGs are not all active+clean and ready"
  fi
else
  record_failure "could not read Ceph PG status"
fi

declare -a daemonsets=(
  rook-ceph.rbd.csi.ceph.com-nodeplugin
  rook-ceph.cephfs.csi.ceph.com-nodeplugin
)

for daemonset in "${daemonsets[@]}"; do
  daemonset_json=
  if ! daemonset_json="$(get_json -n "$namespace" get daemonset "$daemonset" -o json)"; then
    record_failure "missing DaemonSet ${namespace}/${daemonset}"
    continue
  fi
  if ! jq -e '
    .spec.updateStrategy.type == "RollingUpdate"
    and .spec.updateStrategy.rollingUpdate.maxUnavailable == 1
    and .status.desiredNumberScheduled > 0
    and .status.currentNumberScheduled == .status.desiredNumberScheduled
    and .status.updatedNumberScheduled == .status.desiredNumberScheduled
    and .status.numberAvailable == .status.desiredNumberScheduled
    and .status.numberReady == .status.desiredNumberScheduled
  ' >/dev/null <<<"$daemonset_json"; then
    record_failure "${daemonset} is not fully ready with RollingUpdate/maxUnavailable=1"
    continue
  fi

  selector=
  if ! selector="$(jq -r '.spec.selector.matchLabels | to_entries | map(.key + "=" + .value) | join(",")' <<<"$daemonset_json")" || [[ -z "$selector" ]]; then
    record_failure "${daemonset} has no usable selector"
    continue
  fi
  pods_json=
  if ! pods_json="$(get_json -n "$namespace" get pods -l "$selector" -o json)"; then
    record_failure "could not read pods for ${daemonset}"
    continue
  fi
  if ! jq -e --arg image "$expected_image" '
    (.items | length) > 0
    and all(.items[];
      .status.phase == "Running"
      and any(.status.conditions[]?; .type == "Ready" and .status == "True")
      and any(.spec.containers[]?; .image == $image)
    )
  ' >/dev/null <<<"$pods_json"; then
    record_failure "${daemonset} has a missing, unready, or old-image pod"
  fi
done

volume_attachments=
attachment_snapshot='[]'
if volume_attachments="$(get_json get volumeattachments -o json)"; then
  if ! attachment_snapshot="$(jq -S -c '
    [(.items // [])[]
      | select(.spec.attacher == "rook-ceph.rbd.csi.ceph.com" or .spec.attacher == "rook-ceph.cephfs.csi.ceph.com")
      | {
          name: .metadata.name,
          node: .spec.nodeName,
          persistentVolume: .spec.source.persistentVolumeName,
          attached: (.status.attached // false),
          deleting: (.metadata.deletionTimestamp // null),
          error: (.status.attachError // null)
        }
    ] | sort_by(.name)
  ' <<<"$volume_attachments")"; then
    record_failure "VolumeAttachments are not valid JSON"
    attachment_snapshot='[]'
  fi
else
  record_failure "could not read VolumeAttachments"
fi
attachment_count="$(jq 'length' <<<"$attachment_snapshot")"
if ! jq -e 'length > 0 and all(.[]; .attached == true and .deleting == null and .error == null)' \
  >/dev/null <<<"$attachment_snapshot"; then
  record_failure "a RBD/CephFS VolumeAttachment is detached, deleting, or reports an attach error"
fi
attachment_digest="$(printf '%s\n' "$attachment_snapshot" | sha256sum | awk '{print $1}')"
if [[ -n "$baseline_file" ]]; then
  if [[ ! -r "$baseline_file" ]]; then
    record_failure "baseline file is not readable: $baseline_file"
  else
    expected_digest="$(tr -d '[:space:]' <"$baseline_file")"
    if [[ "$expected_digest" != "$attachment_digest" ]]; then
      record_failure "VolumeAttachment digest changed: baseline=${expected_digest} current=${attachment_digest}"
    fi
  fi
fi

if ! get_json get pv -o json >"$tmp_dir/pv.json"; then
  record_failure "could not read PVs"
  printf '{"items":[]}\n' >"$tmp_dir/pv.json"
fi
if ! get_json get pods --all-namespaces -o json >"$tmp_dir/pods.json"; then
  record_failure "could not read pods"
  printf '{"items":[]}\n' >"$tmp_dir/pods.json"
fi

consumer_check_output=
if ! consumer_check_output="$(python3 - "$tmp_dir/pv.json" "$tmp_dir/pods.json" <<'PY'
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

if not consumers:
    raise SystemExit("storage consumers are not ready: no Ceph CSI PVC consumers found")
if failures:
    raise SystemExit("storage consumers are not ready: " + "; ".join(failures))
print(f"storage consumers ready: {len(consumers)}")
PY
)"; then
  record_failure "${consumer_check_output:-could not validate storage consumers}"
fi

functional_failed=0
if ((${#failures[@]} > 0)); then
  functional_failed=1
  printf 'functional storage proof: FAIL\n' >&2
  for failure in "${failures[@]}"; do
    printf ' - %s\n' "$failure" >&2
  done
else
  printf 'functional storage proof: PASS\n'
  if [[ -n "$consumer_check_output" ]]; then
    printf '%s\n' "$consumer_check_output"
  fi
  printf 'context=%s image=%s volumeAttachments=%s attachmentDigest=%s\n' \
    "$context" "$expected_image" "$attachment_count" "$attachment_digest"
fi

if [[ -n "$security_gate_failure" ]]; then
  if ((functional_only == 1)); then
    printf 'storage CSI acceptance: FAIL\n' >&2
    printf ' - %s\n' "$security_gate_failure" >&2
  else
    printf 'security completion: INCOMPLETE (%s)\n' "$security_gate_failure" >&2
  fi
  exit 1
fi

if ((functional_failed == 1)); then
  exit 1
fi

if ((functional_only == 1 && security_complete == 0)); then
  printf 'security completion: INCOMPLETE (approved AES compatibility warnings remain)\n'
else
  printf 'security completion: PASS\n'
fi
printf 'CSI node-plugin acceptance: PASS\n'
