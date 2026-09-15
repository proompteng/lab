#!/usr/bin/env bash
set -Eeuo pipefail

readonly context="${KUBE_CONTEXT:-galactic-tailscale}"
readonly namespace='microvm-demo'
readonly pod='firecracker-turin-microvm'
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_dir

namespace_created='false'
creation_succeeded='false'

cleanup_failed_creation() {
  local status=$?
  trap - EXIT
  if [[ "${creation_succeeded}" != 'true' && "${namespace_created}" == 'true' ]]; then
    kubectl --context "${context}" delete namespace "${namespace}" --wait=true --timeout=5m >/dev/null || true
  fi
  exit "${status}"
}
trap cleanup_failed_creation EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

kubectl --context "${context}" get node turin \
  --output jsonpath='{.metadata.name}{" "}{.status.nodeInfo.architecture}{" "}{.status.conditions[?(@.type=="Ready")].status}{"\n"}' \
  | grep -qx 'turin amd64 True'

if kubectl --context "${context}" get namespace "${namespace}" >/dev/null 2>&1; then
  printf 'refusing to reuse existing namespace: %s\n' "${namespace}" >&2
  exit 1
fi

kubectl --context "${context}" create --filename "${script_dir}/live-namespace.yaml"
namespace_created='true'

kubectl --context "${context}" --namespace "${namespace}" create configmap firecracker-turin-microvm \
  --from-file=launcher.sh="${script_dir}/launcher.sh" \
  --from-file=guest-agent.sh="${script_dir}/guest-agent.sh" \
  --from-file=nanoagent.service="${script_dir}/nanoagent.service" \
  --from-file=guest-control.py="${script_dir}/guest-control.py" \
  --from-file=microvm-control.service="${script_dir}/microvm-control.service" \
  --from-file=host-callback.py="${script_dir}/host-callback.py" \
  --from-file=host-vsock-client.py="${script_dir}/host-vsock-client.py"

kubectl --context "${context}" --namespace "${namespace}" create --filename "${script_dir}/live-pod.yaml"
kubectl --context "${context}" --namespace "${namespace}" wait pod/"${pod}" \
  --for=condition=Ready --timeout=10m

creation_succeeded='true'
kubectl --context "${context}" --namespace "${namespace}" get pod "${pod}" --output wide
printf 'Firecracker microVM Pod is running; remove it with %s/delete-microvm.sh\n' "${script_dir}"
