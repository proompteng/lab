#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXAMPLES_DIR="${ROOT_DIR}/charts/agents/examples"
NAMESPACE="${AGENTS_NAMESPACE:-agents}"
TIMEOUT="${AGENTS_E2E_TIMEOUT:-15m}"
VERIFY_PR="${AGENTS_E2E_VERIFY_PR:-true}"

AGENT_PROVIDER_FILE="${EXAMPLES_DIR}/agentprovider-native-workflow.yaml"
AGENT_FILE="${EXAMPLES_DIR}/agent-native-workflow.yaml"
IMPLEMENTATION_FILE="${EXAMPLES_DIR}/implementationspec-native-workflow.yaml"

AGENT_RUN_NAME="${AGENTS_E2E_RUN_NAME:-codex-native-workflow-e2e}"
REPOSITORY="${AGENTS_E2E_REPO:-proompteng/lab}"
ISSUE_NUMBER="${AGENTS_E2E_ISSUE_NUMBER:-2614}"
ISSUE_TITLE="${AGENTS_E2E_ISSUE_TITLE:-agents: native workflow e2e proof + runbook}"
ISSUE_URL="${AGENTS_E2E_ISSUE_URL:-https://github.com/${REPOSITORY}/issues/${ISSUE_NUMBER}}"
BASE_BRANCH="${AGENTS_E2E_BASE:-main}"
HEAD_BRANCH="${AGENTS_E2E_HEAD:-codex/agents/${ISSUE_NUMBER}}"
PROMPT="${AGENTS_E2E_PROMPT:-Add a short \"Verification checklist\" subsection under the Native workflow e2e proof runbook in docs/agents/runbooks.md that lists steps to confirm AgentRun success, artifact output location, and PR verification. Keep the change documentation-only.}"
SECRET_NAME="${AGENTS_E2E_SECRET_NAME:-codex-github-token}"
GH_TOKEN="${AGENTS_E2E_GH_TOKEN:-}"

OUTPUT_DIR="${AGENTS_E2E_OUTPUT_DIR:-/tmp/agents-native-workflow-e2e-$(date +%Y%m%d-%H%M%S)}"
LOG_DIR="${OUTPUT_DIR}/logs"
ARTIFACT_DIR="${OUTPUT_DIR}/artifacts"

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

indent_prompt() {
  local indented="${PROMPT//$'\n'/$'\n      '}"
  printf '      %s\n' "${indented}"
}

wait_for_phase() {
  local name="$1"
  local expected="$2"
  local timeout="$3"
  if ! kubectl -n "${NAMESPACE}" wait "agentrun/${name}" \
    --for="jsonpath={.status.phase}=${expected}" --timeout="${timeout}"; then
    echo "Timed out waiting for AgentRun ${name} phase=${expected}." >&2
    kubectl -n "${NAMESPACE}" get agentrun "${name}" -o yaml >&2 || true
    exit 1
  fi
}

resolve_pr_url() {
  local pr_url=""

  if [[ "${VERIFY_PR}" != "true" ]]; then
    return 0
  fi

  if command -v gh >/dev/null 2>&1; then
    if [[ -n "${GH_TOKEN}" ]]; then
      export GH_TOKEN
    fi
    pr_url="$(gh pr list --repo "${REPOSITORY}" --head "${HEAD_BRANCH}" --state all --json url -q '.[0].url' 2>/dev/null || true)"
  fi

  if [[ -z "${pr_url}" ]]; then
    return 1
  fi

  echo "${pr_url}"
}

require_command kubectl

mkdir -p "${LOG_DIR}" "${ARTIFACT_DIR}"

if [[ -z "${ISSUE_NUMBER}" ]]; then
  echo "AGENTS_E2E_ISSUE_NUMBER is required." >&2
  exit 1
fi

if [[ -n "${GH_TOKEN}" ]]; then
  log "Applying GitHub token secret ${SECRET_NAME}..."
  kubectl -n "${NAMESPACE}" create secret generic "${SECRET_NAME}" \
    --from-literal=GH_TOKEN="${GH_TOKEN}" \
    --dry-run=client -o yaml | kubectl apply -f -
elif ! kubectl -n "${NAMESPACE}" get secret "${SECRET_NAME}" >/dev/null 2>&1; then
  echo "Missing GitHub token secret ${SECRET_NAME}. Set AGENTS_E2E_GH_TOKEN or create the secret." >&2
  exit 1
fi

log "Applying AgentProvider, Agent, and ImplementationSpec..."
kubectl -n "${NAMESPACE}" apply -f "${AGENT_PROVIDER_FILE}"
kubectl -n "${NAMESPACE}" apply -f "${AGENT_FILE}"
kubectl -n "${NAMESPACE}" apply -f "${IMPLEMENTATION_FILE}"

log "Resetting AgentRun ${AGENT_RUN_NAME} (if present)..."
kubectl -n "${NAMESPACE}" delete agentrun "${AGENT_RUN_NAME}" --ignore-not-found

log "Submitting native workflow AgentRun..."
cat <<EOF | kubectl -n "${NAMESPACE}" apply -f -
apiVersion: agents.proompteng.ai/v1alpha1
kind: AgentRun
metadata:
  name: ${AGENT_RUN_NAME}
spec:
  agentRef:
    name: codex-native-workflow
  implementationSpecRef:
    name: codex-native-workflow-impl
  runtime:
    type: workflow
    config:
      ttlSecondsAfterFinished: 900
  workflow:
    steps:
      - name: implement
        parameters:
          stage: implement
  workload:
    image: ghcr.io/proompteng/codex-agent:latest
    resources:
      requests:
        cpu: 250m
        memory: 512Mi
  secrets:
    - ${SECRET_NAME}
  parameters:
    repository: ${REPOSITORY}
    issueNumber: "${ISSUE_NUMBER}"
    issueTitle: "${ISSUE_TITLE}"
    issueUrl: "${ISSUE_URL}"
    base: "${BASE_BRANCH}"
    head: "${HEAD_BRANCH}"
    prompt: |
$(indent_prompt)
EOF

log "Waiting for AgentRun to reach Succeeded..."
wait_for_phase "${AGENT_RUN_NAME}" "Succeeded" "${TIMEOUT}"

runtime_type="$(kubectl -n "${NAMESPACE}" get agentrun "${AGENT_RUN_NAME}" -o jsonpath='{.status.runtimeRef.type}')"
runtime_name="$(kubectl -n "${NAMESPACE}" get agentrun "${AGENT_RUN_NAME}" -o jsonpath='{.status.runtimeRef.name}')"
if [[ "${runtime_type}" != "workflow" ]]; then
  echo "Expected runtimeRef.type=workflow (got ${runtime_type})." >&2
  kubectl -n "${NAMESPACE}" get agentrun "${AGENT_RUN_NAME}" -o yaml >&2 || true
  exit 1
fi

kubectl -n "${NAMESPACE}" get agentrun "${AGENT_RUN_NAME}" -o json > "${OUTPUT_DIR}/agentrun.json"

log "Collecting job logs and artifacts..."
job_names="$(kubectl -n "${NAMESPACE}" get job -l "agents.proompteng.ai/agent-run=${AGENT_RUN_NAME}" -o jsonpath='{.items[*].metadata.name}')"
if [[ -z "${job_names}" ]]; then
  echo "No workflow jobs found for AgentRun ${AGENT_RUN_NAME}." >&2
  exit 1
fi

for job in ${job_names}; do
  pod="$(kubectl -n "${NAMESPACE}" get pod -l "job-name=${job}" -o jsonpath='{.items[0].metadata.name}')"
  if [[ -z "${pod}" ]]; then
    echo "No pod found for job ${job}." >&2
    continue
  fi
  kubectl -n "${NAMESPACE}" logs "${pod}" > "${LOG_DIR}/${job}.log"
  if kubectl -n "${NAMESPACE}" exec "${pod}" -- test -f /workspace/.agent/runner.log >/dev/null 2>&1; then
    kubectl -n "${NAMESPACE}" cp "${pod}:/workspace/.agent/runner.log" "${ARTIFACT_DIR}/${job}-runner.log" >/dev/null
  fi
  if kubectl -n "${NAMESPACE}" exec "${pod}" -- test -f /workspace/.agent/status.json >/dev/null 2>&1; then
    kubectl -n "${NAMESPACE}" cp "${pod}:/workspace/.agent/status.json" "${ARTIFACT_DIR}/${job}-status.json" >/dev/null
  fi
  echo "${job} -> ${pod}" >> "${OUTPUT_DIR}/jobs.txt"
done

pr_url="$(resolve_pr_url || true)"
if [[ -z "${pr_url}" ]]; then
  log "PR verification skipped or not found. Use: gh pr list --repo ${REPOSITORY} --head \"${HEAD_BRANCH}\""
fi

log "Native workflow e2e complete."
cat <<SUMMARY
Status: Succeeded
AgentRun: ${AGENT_RUN_NAME}
RuntimeRef: ${runtime_type}/${runtime_name}
Output: ${OUTPUT_DIR}
Logs: ${LOG_DIR}
Artifacts: ${ARTIFACT_DIR}
PR: ${pr_url:-not found}
SUMMARY
