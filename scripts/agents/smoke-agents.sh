#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART_DIR="${ROOT_DIR}/charts/agents"
NAMESPACE="${AGENTS_NAMESPACE:-agents}"
RELEASE_NAME="${AGENTS_RELEASE_NAME:-agents}"
VALUES_FILE="${AGENTS_VALUES_FILE:-${CHART_DIR}/values-local.yaml}"
TIMEOUT="${AGENTS_TIMEOUT:-5m}"

require_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "${cmd} is required" >&2
    exit 1
  fi
}

require_command kubectl
require_command helm

helm upgrade --install "${RELEASE_NAME}" "${CHART_DIR}" \
  --namespace "${NAMESPACE}" \
  --create-namespace \
  --values "${VALUES_FILE}"

kubectl -n "${NAMESPACE}" rollout status "deploy/${RELEASE_NAME}" --timeout="${TIMEOUT}"

kubectl -n "${NAMESPACE}" apply -f "${CHART_DIR}/examples/agentprovider-sample.yaml"
kubectl -n "${NAMESPACE}" apply -f "${CHART_DIR}/examples/agent-sample.yaml"
kubectl -n "${NAMESPACE}" apply -f "${CHART_DIR}/examples/memory-sample.yaml"
kubectl -n "${NAMESPACE}" apply -f "${CHART_DIR}/examples/implementationspec-sample.yaml"

kubectl -n "${NAMESPACE}" delete agentrun codex-run-sample --ignore-not-found
kubectl -n "${NAMESPACE}" apply -f "${CHART_DIR}/examples/agentrun-sample.yaml"

kubectl -n "${NAMESPACE}" wait --for=condition=complete job \
  -l agents.proompteng.ai/agent-run=codex-run-sample \
  --timeout="${TIMEOUT}"

kubectl -n "${NAMESPACE}" get agentrun codex-run-sample -o yaml

echo "Agents smoke test completed."
