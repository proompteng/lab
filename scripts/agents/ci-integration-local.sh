#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
}

run_with_helm3() {
  # CI uses Helm v3.
  if command -v mise >/dev/null 2>&1; then
    mise exec helm@3 -- "$@"
    return 0
  fi
  "$@"
}

require_cmd bun
require_cmd docker
require_cmd kind
require_cmd kubectl
require_cmd helm

CLUSTER_NAME="${CLUSTER_NAME:-agents-ci-local-$(date +%s)}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-${ROOT_DIR}/.tmp/agents-ci-local/kubeconfig-${CLUSTER_NAME}}"
NAMESPACE="${AGENTS_NAMESPACE:-agents-ci}"
RELEASE_NAME="${AGENTS_RELEASE_NAME:-agents-ci}"
VALUES_FILE="${AGENTS_VALUES_FILE:-charts/agents/values-ci.yaml}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

mkdir -p "$(dirname "${KUBECONFIG_PATH}")"

echo "[local-agents-ci] versions:"
bun --version
docker version
kind version
kubectl version --client --output=yaml | sed -n '1,20p'
helm version --short

echo "[local-agents-ci] bun install"
(cd "${ROOT_DIR}" && bun install --frozen-lockfile --ignore-scripts)

echo "[local-agents-ci] build agentctl"
(cd "${ROOT_DIR}" && bun run --filter @proompteng/agentctl build:bin)

echo "[local-agents-ci] ensure kind network"
(cd "${ROOT_DIR}" && scripts/agents/ensure-kind-network.sh)

cleanup() {
  if [ "${SKIP_CLEANUP}" = "1" ]; then
    echo "[local-agents-ci] SKIP_CLEANUP=1 set; leaving cluster ${CLUSTER_NAME} running"
    return 0
  fi

set +e
export KUBECONFIG="${KUBECONFIG_PATH}"
run_with_helm3 helm uninstall "${RELEASE_NAME}" -n "${NAMESPACE}" >/dev/null 2>&1 || true
kubectl delete namespace "${NAMESPACE}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
kind delete cluster --name "${CLUSTER_NAME}" >/dev/null 2>&1 || true
set -e
}
trap cleanup EXIT

echo "[local-agents-ci] create kind cluster: ${CLUSTER_NAME}"
kind delete cluster --name "${CLUSTER_NAME}" >/dev/null 2>&1 || true
kind create cluster --name "${CLUSTER_NAME}" --image kindest/node:v1.29.4 --wait 180s --kubeconfig "${KUBECONFIG_PATH}"

export KUBECONFIG="${KUBECONFIG_PATH}"
kubectl get nodes -o wide

echo "[local-agents-ci] run smoke"
(cd "${ROOT_DIR}" && \
  AGENTS_NAMESPACE="${NAMESPACE}" \
  AGENTS_RELEASE_NAME="${RELEASE_NAME}" \
  AGENTS_VALUES_FILE="${VALUES_FILE}" \
  AGENTS_CREATE_NAMESPACE="true" \
  AGENTS_DB_BOOTSTRAP="true" \
  AGENTS_TIMEOUT="${AGENTS_TIMEOUT:-10m}" \
  AGENTCTL_BIN="${AGENTCTL_BIN:-services/jangar/agentctl/dist/agentctl}" \
  bun run packages/scripts/src/agents/smoke-agents.ts)

echo "[local-agents-ci] success"

