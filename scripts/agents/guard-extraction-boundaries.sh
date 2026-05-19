#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART_DIR="${ROOT_DIR}/charts/agents"
ARGO_DIR="${ROOT_DIR}/argocd/applications/agents"

fail_if_matches() {
  local description="$1"
  local pattern="$2"
  shift 2

  if rg -n \
    --glob '!**/__tests__/**' \
    --glob '!**/*.test.*' \
    --glob '!**/*_test.go' \
    --glob '!guard-extraction-boundaries.sh' \
    "${pattern}" \
    "$@"; then
    echo "Agents extraction boundary violation: ${description}" >&2
    exit 1
  fi
}

fail_if_matches \
  "services/agents must not import or package Jangar-local runner paths" \
  'services/jangar|/app/services/jangar|codex-implement' \
  "${ROOT_DIR}/services/agents/src" \
  "${ROOT_DIR}/services/agents/package.json" \
  "${ROOT_DIR}/services/agents/Dockerfile" \
  "${ROOT_DIR}/services/agents/Dockerfile.codex-runner"

fail_if_matches \
  "Agents build and CI entrypoints must not call the Jangar Dockerfile or Jangar image builder" \
  'services/jangar/Dockerfile|\.\./jangar/build-image' \
  "${ROOT_DIR}/.github/workflows/agents-build-push.yml" \
  "${ROOT_DIR}/.github/workflows/agents-ci.yml" \
  "${ROOT_DIR}/scripts/agents" \
  "${ROOT_DIR}/packages/scripts/src/agents"

fail_if_matches \
  "Jangar GitOps must not own Codex run-complete ingestion" \
  'uri: /api/codex/run-complete|name: jangar-codex-completions|workflow-completions-rbac|workflow-completions-eventsource' \
  "${ROOT_DIR}/argocd/applications/jangar"

fail_if_matches \
  "Jangar GitOps must not point Codex execution back at Facteur or legacy Codex orchestrations" \
  'FACTEUR_INTERNAL_URL|codex-autonomous|github-codex-implementation' \
  "${ROOT_DIR}/argocd/applications/jangar"

fail_if_matches \
  "Jangar GitOps must not ship legacy Codex workflow service accounts or RBAC" \
  'codex-workflow-rbac|name: codex-workflow|serviceAccountName: codex-workflow' \
  "${ROOT_DIR}/argocd/applications/jangar"

fail_if_matches \
  "Jangar Codex judge must not submit reruns through Facteur task ingress" \
  'facteurBaseUrl|FACTEUR_INTERNAL_URL|/codex/tasks|CodexTaskSchema' \
  "${ROOT_DIR}/services/jangar/src/server/codex-judge.ts" \
  "${ROOT_DIR}/services/jangar/src/server/codex-judge-config.ts"

fail_if_matches \
  "Jangar market-context dispatch must submit AgentRuns through the Agents service boundary, not direct Kubernetes apply" \
  'createKubernetesClient|RESOURCE_MAP\.AgentRun|\.apply\(' \
  "${ROOT_DIR}/services/jangar/src/server/torghut-market-context-dispatch.ts"

fail_if_matches \
  "Jangar whitepaper finalizer must consume AgentRuns through the Agents service boundary, not direct Kubernetes watch/list/patch" \
  'createKubernetesClient|RESOURCE_MAP\.AgentRun|startResourceWatch|kube\.list|kube\.patch' \
  "${ROOT_DIR}/services/jangar/src/server/whitepaper-finalize-consumer.ts"

fail_if_matches \
  "Jangar KubeGateway must list Agents CRDs through the Agents service boundary, not direct Kubernetes CRD access" \
  'RESOURCE_MAP|agentruns\.agents\.proompteng\.ai|swarms\.swarm\.proompteng\.ai' \
  "${ROOT_DIR}/services/jangar/src/server/kube-gateway.ts"

fail_if_matches \
  "Jangar swarm analysis must read AgentRun and OrchestrationRun targets through the Agents service boundary" \
  'createKubernetesClient|RESOURCE_MAP\.(AgentRun|OrchestrationRun)' \
  "${ROOT_DIR}/services/jangar/src/server/supporting-primitives-swarm-analysis.ts"

fail_if_matches \
  "Jangar schedule runner must submit scheduled AgentRun and OrchestrationRun resources through the Agents service boundary" \
  'KUBERNETES_SERVICE_HOST|KUBERNETES_SERVICE_PORT|/apis/\$\{target\.group\}|node:https|requestKubernetesJson|/var/run/secrets/kubernetes\.io/serviceaccount/token' \
  "${ROOT_DIR}/services/jangar/src/server/supporting-primitives-schedule-runner.ts"

fail_if_matches \
  "Jangar material-reentry Swarm reconciler must consume Swarms through the Agents service boundary" \
  'RESOURCE_MAP\.Swarm|startResourceWatch|createKubernetesClient|kube\.list' \
  "${ROOT_DIR}/services/jangar/src/server/supporting-primitives-material-reentry-swarm-reconciler.ts"

fail_if_matches \
  "Jangar primitive policy validation must read ApprovalPolicy, Budget, and SecretBinding through the Agents service boundary" \
  'RESOURCE_MAP\.(ApprovalPolicy|Budget|SecretBinding)|KubernetesClient|kube\.get' \
  "${ROOT_DIR}/services/jangar/src/server/primitives-policy.ts"

fail_if_matches \
  "Agents GitOps must not ship the old sample Argo WorkflowTemplate schedule bridge" \
  'agents-primitives-echo|kind: WorkflowTemplate|codex-workflow' \
  "${ROOT_DIR}/argocd/applications/agents"

fail_if_matches \
  "Facteur, Froussard, and shared Argo GitOps must not use the legacy codex-universal runtime" \
  'codex-universal|/usr/local/bin/codex-bootstrap|ghcr.io/openai/codex-universal' \
  "${ROOT_DIR}/argocd/applications/facteur" \
  "${ROOT_DIR}/argocd/applications/froussard" \
  "${ROOT_DIR}/argocd/applications/argo-workflows"

fail_if_matches \
  "Facteur GitOps and server runtime must not expose the legacy /codex/tasks AgentRun ingress" \
  '/codex/tasks' \
  "${ROOT_DIR}/argocd/applications/facteur" \
  "${ROOT_DIR}/services/facteur/internal/server" \
  "${ROOT_DIR}/services/facteur/README.md"

fail_if_matches \
  "Facteur must dispatch Codex work through Agents AgentRuns, not direct runner WorkflowTemplates" \
  'kind: WorkflowTemplate|agents-codex-runner|agent-runner --spec|facteur-workflow|FACTEUR_ARGO_|facteur-dispatch' \
  "${ROOT_DIR}/argocd/applications/facteur"

fail_if_matches \
  "Facteur dispatch surfaces must expose Agents AgentRun names, not Argo workflow aliases" \
  'ArgoConfig|cfg\.Argo|WorkflowName|WorkflowTemplate|workflowName|workflow_name|argo\.parameters' \
  "${ROOT_DIR}/services/facteur/cmd" \
  "${ROOT_DIR}/services/facteur/internal" \
  "${ROOT_DIR}/services/facteur/config" \
  "${ROOT_DIR}/proto/proompteng/facteur/v1/contract.proto" \
  "${ROOT_DIR}/apps/froussard/src/proto/proompteng/facteur/v1/contract_pb.ts"

fail_if_matches \
  "Froussard GitOps must not ship legacy Codex implementation WorkflowTemplates" \
  'github-codex-implementation-workflow-template|codex-run-workflow-template-jangar|codex-autonomous-workflow-template|github-codex-post-deploy-workflow-template' \
  "${ROOT_DIR}/argocd/applications/froussard"

fail_if_matches \
  "Froussard GitOps must not own generic Argo workflow completion ingestion" \
  'event-bus\.yaml|kind: EventBus|workflow-completions|argo-workflows-completions-topic|argo\.workflows\.completions' \
  "${ROOT_DIR}/argocd/applications/froussard"

fail_if_matches \
  "Froussard webhook/runtime identity must be AgentRun-native, not Argo workflow-native" \
  'ARGO_WORKFLOW_|workflowIdentifier|_Workflow:' \
  "${ROOT_DIR}/apps/froussard/src"

rendered_chart="$(mktemp)"
rendered_argo="$(mktemp)"
cleanup() {
  rm -f "${rendered_chart}" "${rendered_argo}"
}
trap cleanup EXIT

helm template agents "${CHART_DIR}" --namespace agents > "${rendered_chart}"
kubectl kustomize "${ARGO_DIR}" --enable-helm > "${rendered_argo}"

rendered_forbidden='JANGAR_|jangar-db-app|/etc/jangar|lab/jangar|/app/services/jangar|services/jangar|codex-implement|consumerGroup: jangar|AGENTS_TORGHUT_STATUS_|AGENTS_WHITEPAPER_FINALIZE_'
agents_runtime_forbidden='codex-universal|ghcr.io/openai/codex-universal'
fail_if_matches "rendered Helm chart must use Agents-owned images, env, DB secret, and runner paths" "${rendered_forbidden}" "${rendered_chart}"
fail_if_matches "rendered Agents GitOps app must use Agents-owned images, env, DB secret, and runner paths" "${rendered_forbidden}" "${rendered_argo}"
fail_if_matches "rendered Agents GitOps app must use the chart-managed agents-codex-runner path" "${agents_runtime_forbidden}" "${rendered_argo}"

if ! rg -U 'name: AGENTS_SWARM_PRIMITIVE_ENABLED\n\s+value: "true"' "${rendered_argo}" >/dev/null; then
  echo "Agents extraction boundary violation: rendered Agents GitOps app must enable the Swarm primitive when it ships the supporting controller." >&2
  exit 1
fi

if ! rg -U 'apiGroups:\n\s+- swarm\.proompteng\.ai\n\s+resources:\n\s+- swarms' "${rendered_argo}" >/dev/null; then
  echo "Agents extraction boundary violation: rendered Agents GitOps app must grant Swarm RBAC when the Swarm primitive is enabled." >&2
  exit 1
fi
