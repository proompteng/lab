#!/usr/bin/env bash
set -Eeuo pipefail

readonly context="${KUBE_CONTEXT:-galactic-tailscale}"
readonly namespace='microvm-spike'
readonly pod='firecracker-turin-spike'
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly script_dir
readonly evidence_log="${EVIDENCE_LOG:-/tmp/firecracker-turin-spike.log}"

namespace_created='false'

cleanup() {
  if [[ "${KEEP_RESOURCES:-false}" == 'true' || "${namespace_created}" != 'true' ]]; then
    return
  fi

  kubectl --context "${context}" delete namespace "${namespace}" --wait=true --timeout=5m >/dev/null
  namespace_created='false'
}
trap cleanup EXIT INT TERM

kubectl --context "${context}" get node turin \
  --output jsonpath='{.metadata.name}{" "}{.status.nodeInfo.architecture}{" "}{.status.conditions[?(@.type=="Ready")].status}{"\n"}' \
  | grep -qx 'turin amd64 True'

if kubectl --context "${context}" get namespace "${namespace}" >/dev/null 2>&1; then
  printf 'refusing to reuse existing namespace: %s\n' "${namespace}" >&2
  exit 1
fi

kubectl --context "${context}" create --filename "${script_dir}/namespace.yaml"
namespace_created='true'

kubectl --context "${context}" --namespace "${namespace}" create configmap firecracker-turin-spike \
  --from-file=launcher.sh="${script_dir}/launcher.sh" \
  --from-file=guest-agent.sh="${script_dir}/guest-agent.sh" \
  --from-file=nanoagent.service="${script_dir}/nanoagent.service" \
  --from-file=guest-control.py="${script_dir}/guest-control.py" \
  --from-file=microvm-control.service="${script_dir}/microvm-control.service" \
  --from-file=host-callback.py="${script_dir}/host-callback.py" \
  --from-file=host-vsock-client.py="${script_dir}/host-vsock-client.py" \
  --dry-run=client \
  --output yaml \
  | kubectl --context "${context}" --namespace "${namespace}" apply --filename -

kubectl --context "${context}" --namespace "${namespace}" delete pod "${pod}" \
  --ignore-not-found --wait=true
kubectl --context "${context}" --namespace "${namespace}" apply --filename "${script_dir}/pod.yaml"
kubectl --context "${context}" --namespace "${namespace}" wait pod/"${pod}" \
  --for=condition=Ready --timeout=5m

kubectl --context "${context}" --namespace "${namespace}" logs --follow pod/"${pod}" \
  | tee "${evidence_log}"

phase=''
for _ in $(seq 1 30); do
  phase="$(kubectl --context "${context}" --namespace "${namespace}" get pod "${pod}" \
    --output jsonpath='{.status.phase}')"
  if [[ "${phase}" == 'Succeeded' || "${phase}" == 'Failed' ]]; then
    break
  fi
  sleep 1
done
readonly phase
if [[ "${phase}" != 'Succeeded' ]]; then
  kubectl --context "${context}" --namespace "${namespace}" describe pod "${pod}"
  exit 1
fi

grep -q '^SPIKE result=PASS$' "${evidence_log}"
cleanup

if kubectl --context "${context}" get namespace "${namespace}" >/dev/null 2>&1; then
  printf 'namespace cleanup verification failed: %s still exists\n' "${namespace}" >&2
  exit 1
fi

printf 'Turin Firecracker spike passed; evidence: %s; namespace cleanup: verified\n' "${evidence_log}"
