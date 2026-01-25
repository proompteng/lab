#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART_DIR="${ROOT_DIR}/charts/agents"
NAMESPACE="${AGENTS_NAMESPACE:-agents}"
RELEASE_NAME="${AGENTS_RELEASE_NAME:-agents}"
VALUES_FILE="${AGENTS_VALUES_FILE:-${CHART_DIR}/values-local.yaml}"
TIMEOUT="${AGENTS_TIMEOUT:-5m}"
AGENT_RUN_FILE="${AGENTS_RUN_FILE:-${CHART_DIR}/examples/agentrun-workflow-smoke.yaml}"
AGENT_RUN_NAME="${AGENTS_RUN_NAME:-agents-workflow-smoke}"
WORKFLOW_STEPS_EXPECTED="${AGENTS_WORKFLOW_STEPS_EXPECTED:-}"
CREATE_NAMESPACE="${AGENTS_CREATE_NAMESPACE:-true}"
DB_BOOTSTRAP="${AGENTS_DB_BOOTSTRAP:-false}"
DB_URL="${AGENTS_DB_URL:-}"
DB_USER="${AGENTS_DB_USER:-agents}"
DB_NAME="${AGENTS_DB_NAME:-agents}"
DB_PASSWORD="${AGENTS_DB_PASSWORD:-}"
DB_HOST="${AGENTS_DB_HOST:-${RELEASE_NAME}-postgres}"
DB_PORT="${AGENTS_DB_PORT:-5432}"
AGENTCTL_BIN="${AGENTCTL_BIN:-agentctl}"
AGENTCTL_ARGS=()

if [[ "${AGENTCTL_BIN}" == *.js ]]; then
  AGENTCTL_ARGS=("${AGENTCTL_BIN}")
  AGENTCTL_BIN="node"
fi

CREATE_NAMESPACE_FLAG=""
if [[ "${CREATE_NAMESPACE}" == "true" ]]; then
  CREATE_NAMESPACE_FLAG="--create-namespace"
fi

require_command() {
  local cmd="$1"
  if [[ -x "${cmd}" ]]; then
    return 0
  fi
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "${cmd} is required" >&2
    exit 1
  fi
}

log() {
  echo "[$(date +'%H:%M:%S')] $*"
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
    if [[ "${phase}" == "Succeeded" ]]; then
      if [[ "${expected}" == "Pending" || "${expected}" == "Running" ]]; then
        return 0
      fi
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

wait_for_agentrun() {
  local name="$1"
  local timeout_seconds="$2"
  local start
  start="$(date +%s)"
  while true; do
    if kubectl -n "${NAMESPACE}" get agentrun "${name}" >/dev/null 2>&1; then
      return 0
    fi
    if (( $(date +%s) - start >= timeout_seconds )); then
      echo "Timed out waiting for AgentRun ${name} to appear." >&2
      exit 1
    fi
    sleep 1
  done
}

get_expected_steps() {
  if [[ -n "${WORKFLOW_STEPS_EXPECTED}" ]]; then
    echo "${WORKFLOW_STEPS_EXPECTED}"
    return 0
  fi
  local steps
  steps="$(kubectl -n "${NAMESPACE}" get agentrun "${AGENT_RUN_NAME}" -o jsonpath='{.spec.workflow.steps[*].name}' 2>/dev/null || true)"
  if [[ -z "${steps}" ]]; then
    echo "0"
    return 0
  fi
  wc -w <<<"${steps}" | tr -d ' '
}

require_command kubectl
require_command helm
require_command "${AGENTCTL_BIN}"

if [[ "${DB_BOOTSTRAP}" == "true" ]]; then
  namespace_check_output="$(mktemp)"
  if ! kubectl get namespace "${NAMESPACE}" >/dev/null 2>"${namespace_check_output}"; then
    if grep -Ei "forbidden|cannot" "${namespace_check_output}" >/dev/null 2>&1; then
      if [[ "${CREATE_NAMESPACE}" == "true" ]]; then
        echo "Insufficient permissions to verify or create namespace ${NAMESPACE}." >&2
        rm -f "${namespace_check_output}"
        exit 1
      fi
      log "Skipping namespace existence check for ${NAMESPACE} due to RBAC."
    elif [[ "${CREATE_NAMESPACE}" == "true" ]]; then
      kubectl create namespace "${NAMESPACE}"
    else
      echo "Namespace ${NAMESPACE} does not exist and AGENTS_CREATE_NAMESPACE=false." >&2
      rm -f "${namespace_check_output}"
      exit 1
    fi
  fi
  rm -f "${namespace_check_output}"
  if [[ -z "${DB_PASSWORD}" ]]; then
    if command -v python3 >/dev/null 2>&1; then
      DB_PASSWORD="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(12))
PY
)"
    else
      DB_PASSWORD="$(date +%s)"
    fi
  fi
  if [[ -z "${DB_URL}" ]]; then
    DB_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=disable"
  fi

  log "Bootstrapping postgres for smoke test..."
  cat <<EOF | kubectl -n "${NAMESPACE}" apply -f -
apiVersion: v1
kind: Service
metadata:
  name: ${DB_HOST}
spec:
  selector:
    app: ${DB_HOST}
  ports:
    - port: ${DB_PORT}
      targetPort: ${DB_PORT}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${DB_HOST}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${DB_HOST}
  template:
    metadata:
      labels:
        app: ${DB_HOST}
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          env:
            - name: POSTGRES_USER
              value: ${DB_USER}
            - name: POSTGRES_PASSWORD
              value: ${DB_PASSWORD}
            - name: POSTGRES_DB
              value: ${DB_NAME}
          ports:
            - containerPort: ${DB_PORT}
          readinessProbe:
            tcpSocket:
              port: ${DB_PORT}
            initialDelaySeconds: 5
            periodSeconds: 5
EOF

  kubectl -n "${NAMESPACE}" rollout status "deploy/${DB_HOST}" --timeout="${TIMEOUT}"
fi

HELM_EXTRA_ARGS=()
if [[ -n "${DB_URL}" ]]; then
  HELM_EXTRA_ARGS+=(--set-string "database.url=${DB_URL}")
fi

helm upgrade --install "${RELEASE_NAME}" "${CHART_DIR}" \
  --namespace "${NAMESPACE}" \
  ${CREATE_NAMESPACE_FLAG} \
  --values "${VALUES_FILE}" \
  "${HELM_EXTRA_ARGS[@]}"

kubectl -n "${NAMESPACE}" rollout status "deploy/${RELEASE_NAME}" --timeout="${TIMEOUT}"

kubectl -n "${NAMESPACE}" apply -f "${CHART_DIR}/examples/agentprovider-smoke.yaml"
kubectl -n "${NAMESPACE}" apply -f "${CHART_DIR}/examples/agent-smoke.yaml"
kubectl -n "${NAMESPACE}" apply -f "${CHART_DIR}/examples/implementationspec-smoke.yaml"

kubectl -n "${NAMESPACE}" delete agentrun "${AGENT_RUN_NAME}" --ignore-not-found

if [[ ! -f "${AGENT_RUN_FILE}" ]]; then
  echo "AgentRun file not found: ${AGENT_RUN_FILE}" >&2
  exit 1
fi

log "Submitting workflow AgentRun via agentctl..."
AGENTCTL_NAMESPACE="${NAMESPACE}" \
  "${AGENTCTL_BIN}" "${AGENTCTL_ARGS[@]}" run apply -f "${AGENT_RUN_FILE}"

wait_for_agentrun "${AGENT_RUN_NAME}" 60
WORKFLOW_STEPS_EXPECTED="$(get_expected_steps)"
if [[ "${WORKFLOW_STEPS_EXPECTED}" -lt 1 ]]; then
  echo "Workflow steps expected must be >= 1 (got ${WORKFLOW_STEPS_EXPECTED})." >&2
  kubectl -n "${NAMESPACE}" get agentrun "${AGENT_RUN_NAME}" -o yaml
  exit 1
fi

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
runtime_name="$(kubectl -n "${NAMESPACE}" get agentrun "${AGENT_RUN_NAME}" -o jsonpath='{.status.runtimeRef.name}')"
if [[ -z "${runtime_name}" ]]; then
  echo "Expected runtimeRef.name to be set for workflow runtime." >&2
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
