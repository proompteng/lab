#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART_DIR="${ROOT_DIR}/charts/agents"
NAMESPACE="${AGENTS_NAMESPACE:-agents}"
RELEASE_NAME="${AGENTS_RELEASE_NAME:-agents}"
VALUES_FILE="${AGENTS_VALUES_FILE:-${CHART_DIR}/values-local.yaml}"
TIMEOUT="${AGENTS_TIMEOUT:-5m}"
GRPC_PORT="${AGENTS_GRPC_PORT:-50051}"
GRPC_LOCAL_PORT="${AGENTS_GRPC_LOCAL_PORT:-50051}"
AGENT_RUN_NAME="${AGENTS_RUN_NAME:-codex-run-sample}"
WORKFLOW_STEPS_EXPECTED="${AGENTS_WORKFLOW_STEPS_EXPECTED:-2}"

PORT_FORWARD_PID=""

require_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "${cmd} is required" >&2
    exit 1
  fi
}

log() {
  echo "[$(date +'%H:%M:%S')] $*"
}

cleanup() {
  if [[ -n "${PORT_FORWARD_PID}" ]] && kill -0 "${PORT_FORWARD_PID}" >/dev/null 2>&1; then
    kill "${PORT_FORWARD_PID}" >/dev/null 2>&1 || true
    wait "${PORT_FORWARD_PID}" >/dev/null 2>&1 || true
  fi
}

wait_for_port() {
  local port="$1"
  local timeout_seconds="$2"
  local start
  start="$(date +%s)"
  while true; do
    if (echo >/dev/tcp/127.0.0.1/"${port}") >/dev/null 2>&1; then
      return 0
    fi
    if (( $(date +%s) - start >= timeout_seconds )); then
      return 1
    fi
    sleep 1
  done
}

wait_for_phase() {
  local name="$1"
  local expected="$2"
  local timeout_seconds="$3"
  local start
  start="$(date +%s)"
  while true; do
    local phase
    phase="$(kubectl -n "${NAMESPACE}" get agentrun "${name}" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
    if [[ "${phase}" == "${expected}" ]]; then
      return 0
    fi
    if [[ "${phase}" == "Failed" ]]; then
      echo "AgentRun failed while waiting for phase ${expected}." >&2
      kubectl -n "${NAMESPACE}" get agentrun "${name}" -o yaml
      exit 1
    fi
    if (( $(date +%s) - start >= timeout_seconds )); then
      echo "Timed out waiting for phase ${expected} (last=${phase})." >&2
      kubectl -n "${NAMESPACE}" get agentrun "${name}" -o yaml
      exit 1
    fi
    sleep 1
  done
}

wait_for_jobs() {
  local name="$1"
  local expected="$2"
  local timeout_seconds="$3"
  local start
  start="$(date +%s)"
  while true; do
    local count
    count="$(kubectl -n "${NAMESPACE}" get job -l "agents.proompteng.ai/agent-run=${name}" \
      -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | wc -w | tr -d ' ')"
    if [[ "${count}" -ge "${expected}" ]]; then
      return 0
    fi
    if (( $(date +%s) - start >= timeout_seconds )); then
      echo "Timed out waiting for ${expected} job(s) (last count=${count})." >&2
      kubectl -n "${NAMESPACE}" get job -l "agents.proompteng.ai/agent-run=${name}" -o yaml
      exit 1
    fi
    sleep 1
  done
}

require_command kubectl
require_command helm
require_command agentctl

trap cleanup EXIT

helm upgrade --install "${RELEASE_NAME}" "${CHART_DIR}" \
  --namespace "${NAMESPACE}" \
  --create-namespace \
  --values "${VALUES_FILE}" \
  --set grpc.enabled=true

kubectl -n "${NAMESPACE}" rollout status "deploy/${RELEASE_NAME}" --timeout="${TIMEOUT}"

kubectl -n "${NAMESPACE}" apply -f "${CHART_DIR}/examples/agentprovider-sample.yaml"
kubectl -n "${NAMESPACE}" apply -f "${CHART_DIR}/examples/agent-sample.yaml"
kubectl -n "${NAMESPACE}" apply -f "${CHART_DIR}/examples/memory-sample.yaml"
kubectl -n "${NAMESPACE}" apply -f "${CHART_DIR}/examples/implementationspec-sample.yaml"

kubectl -n "${NAMESPACE}" delete agentrun "${AGENT_RUN_NAME}" --ignore-not-found

log "Starting gRPC port-forward for agentctl..."
kubectl -n "${NAMESPACE}" port-forward "svc/${RELEASE_NAME}-grpc" \
  "${GRPC_LOCAL_PORT}:${GRPC_PORT}" >/tmp/agents-grpc-portforward.log 2>&1 &
PORT_FORWARD_PID=$!
if ! wait_for_port "${GRPC_LOCAL_PORT}" 30; then
  echo "Timed out waiting for agentctl gRPC port-forward on ${GRPC_LOCAL_PORT}." >&2
  cat /tmp/agents-grpc-portforward.log >&2 || true
  exit 1
fi

log "Submitting workflow AgentRun via agentctl..."
AGENTCTL_SERVER="127.0.0.1:${GRPC_LOCAL_PORT}" \
AGENTCTL_NAMESPACE="${NAMESPACE}" \
  agentctl run apply -f "${CHART_DIR}/examples/agentrun-sample.yaml"

log "Waiting for AgentRun phase transitions..."
wait_for_phase "${AGENT_RUN_NAME}" "Pending" 60
wait_for_phase "${AGENT_RUN_NAME}" "Running" 300

log "Waiting for workflow jobs to complete..."
wait_for_jobs "${AGENT_RUN_NAME}" "${WORKFLOW_STEPS_EXPECTED}" 300
kubectl -n "${NAMESPACE}" wait --for=condition=complete job \
  -l "agents.proompteng.ai/agent-run=${AGENT_RUN_NAME}" \
  --timeout="${TIMEOUT}"

wait_for_phase "${AGENT_RUN_NAME}" "Succeeded" 300

runtime_type="$(kubectl -n "${NAMESPACE}" get agentrun "${AGENT_RUN_NAME}" -o jsonpath='{.status.runtimeRef.type}')"
if [[ "${runtime_type}" != "workflow" ]]; then
  echo "Expected runtimeRef.type=workflow (got ${runtime_type})." >&2
  kubectl -n "${NAMESPACE}" get agentrun "${AGENT_RUN_NAME}" -o yaml
  exit 1
fi

job_refs="$(kubectl -n "${NAMESPACE}" get agentrun "${AGENT_RUN_NAME}" -o jsonpath='{.status.workflow.steps[*].jobRef.name}')"
job_ref_count="$(wc -w <<<"${job_refs}" | tr -d ' ')"
if [[ "${job_ref_count}" -lt "${WORKFLOW_STEPS_EXPECTED}" ]]; then
  echo "Expected ${WORKFLOW_STEPS_EXPECTED} workflow jobRefs (got ${job_ref_count})." >&2
  kubectl -n "${NAMESPACE}" get agentrun "${AGENT_RUN_NAME}" -o yaml
  exit 1
fi

log "Agents workflow smoke test completed."
