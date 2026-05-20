#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART_DIR="${ROOT_DIR}/charts/agents"
ARGO_DIR="${ROOT_DIR}/argocd/applications/agents"
TRAEFIK_VALUES="${ROOT_DIR}/argocd/applications/traefik/values.yaml"

fail_if_matches() {
  local description="$1"
  local pattern="$2"
  shift 2

  if search_matches "${pattern}" "$@"; then
    echo "Agents extraction boundary violation: ${description}" >&2
    exit 1
  fi
}

require_matches() {
  local description="$1"
  local pattern="$2"
  shift 2

  if ! search_matches "${pattern}" "$@" >/dev/null; then
    echo "Agents extraction boundary violation: ${description}" >&2
    exit 1
  fi
}

search_matches() {
  local pattern="$1"
  shift

  local paths=()
  local path
  for path in "$@"; do
    if [[ -e "${path}" ]]; then
      paths+=("${path}")
    fi
  done

  if [[ "${#paths[@]}" -eq 0 ]]; then
    return 1
  fi

  if command -v rg >/dev/null 2>&1; then
    rg -n \
      --glob '!**/__tests__/**' \
      --glob '!**/*.test.*' \
      --glob '!**/*_test.go' \
      --glob '!guard-extraction-boundaries.sh' \
      "${pattern}" \
      "${paths[@]}"
    return
  fi

  grep -R -E -n \
    --exclude-dir='__tests__' \
    --exclude='*.test.*' \
    --exclude='*_test.go' \
    --exclude='guard-extraction-boundaries.sh' \
    -- "${pattern}" "${paths[@]}" 2>/dev/null
}

matches_multiline() {
  local pattern="$1"
  shift

  if command -v rg >/dev/null 2>&1; then
    rg -U "${pattern}" "$@" >/dev/null
    return
  fi

  python3 - "$pattern" "$@" <<'PY'
import pathlib
import re
import sys

pattern = sys.argv[1]
for candidate in sys.argv[2:]:
    if re.search(pattern, pathlib.Path(candidate).read_text()):
        raise SystemExit(0)
raise SystemExit(1)
PY
}

fail_if_path_exists() {
  local description="$1"
  shift

  local path
  for path in "$@"; do
    if [[ -e "${path}" ]]; then
      echo "Agents extraction boundary violation: ${description}: ${path}" >&2
      exit 1
    fi
  done
}

fail_if_matches \
  "Jangar must not reintroduce same-origin Agents API route proxy wrappers for /api/agents/* or /v1/agent-runs" \
  "proxyAgentsServiceRequest|AGENTS_SERVICE_PATH|createFileRoute\\('/api/agents|createFileRoute\\('/v1/agent-runs" \
  "${ROOT_DIR}/services/jangar/src/routes/api/agents" \
  "${ROOT_DIR}/services/jangar/src/routes/v1/agent-runs.ts"

fail_if_matches \
  "Jangar must not reintroduce Agents same-origin proxy helpers after direct Agents route ownership" \
  'proxyAgentsServiceRequest|buildAgentsServiceProxyUrl' \
  "${ROOT_DIR}/services/jangar/src/server/agents-service-client.ts" \
  "${ROOT_DIR}/services/jangar/src"

fail_if_path_exists \
  "Jangar must not retain generic Agents runtime evidence collectors after Agents owns workflow and rollout status" \
  "${ROOT_DIR}/services/jangar/src/server/control-plane-workflows.ts" \
  "${ROOT_DIR}/services/jangar/src/server/control-plane-rollout-health.ts"

fail_if_path_exists \
  "Jangar must not infer generic AgentRun ingestion readiness after Agents owns /ready ingestion assessment" \
  "${ROOT_DIR}/services/jangar/src/server/control-plane-serving-process-status.ts"

fail_if_matches \
  "Jangar /ready must consume Agents-reported AgentRun ingestion instead of rebuilding it from controller internals" \
  'buildAgentRunIngestionStatus|agentrun_ingestion_not_ready' \
  "${ROOT_DIR}/services/jangar/src/routes/ready.tsx"

fail_if_matches \
  "Jangar config must not carry generic Agents runtime evidence knobs after Agents owns workflow and rollout status" \
  'JANGAR_CONTROL_PLANE_ROLLOUT_DEPLOYMENTS|JANGAR_WORKFLOWS_WINDOW_MINUTES|JANGAR_WORKFLOWS_WARNING_BACKOFF_THRESHOLD|JANGAR_WORKFLOWS_DEGRADED_BACKOFF_THRESHOLD|workflowsWindowMinutes|rolloutDeployments|workflowsWarningBackoffThreshold|workflowsDegradedBackoffThreshold' \
  "${ROOT_DIR}/services/jangar/src/server/control-plane-config.ts"

fail_if_matches \
  "Jangar kube gateway must not list generic Agents runtime Deployment/Job/Pod resources directly" \
  "client\\.list\\(['\"](deployments|jobs\\.batch|pods)['\"]" \
  "${ROOT_DIR}/services/jangar/src/server/kube-gateway.ts"

fail_if_matches \
  "Jangar kube gateway must not expose generic Agents AgentRun/Job/Pod/Swarm listers or DTOs after Agents owns runtime evidence" \
  'list(AgentRuns|Jobs|Pods|Swarms)|KubeGateway(AgentRun|Job|Pod|Swarm|Container|Condition)' \
  "${ROOT_DIR}/services/jangar/src/server/kube-gateway.ts"

fail_if_matches \
  "Jangar must not fetch generic Agents Deployment resources after Agents owns rollout health" \
  "kind: 'Deployment'|kind: \"Deployment\"" \
  "${ROOT_DIR}/services/jangar/src/server/kube-gateway.ts"

require_matches \
  "Agents GitOps kustomization must include the canonical agents.k8s.proompteng.ai IngressRoute" \
  'ingressroute-agents-api\.yaml' \
  "${ARGO_DIR}/kustomization.yaml"

require_matches \
  "canonical agents.k8s.proompteng.ai route must be owned by the Agents namespace" \
  'Host\(.*agents\.k8s\.proompteng\.ai.*\)' \
  "${ARGO_DIR}/ingressroute-agents-api.yaml"

require_matches \
  "Agents GitOps must declare an Agents-owned Postgres cluster before the database cutover" \
  'name: agents-db-next' \
  "${ARGO_DIR}/postgres-cluster.yaml"

require_matches \
  "Agents-owned Postgres cluster must bootstrap an Agents database owned by the Agents service user" \
  'database: agents' \
  "${ARGO_DIR}/postgres-cluster.yaml"

require_matches \
  "Agents-owned Postgres cluster must install pgvector for Memory resources that advertise vector capability" \
  'CREATE EXTENSION IF NOT EXISTS vector' \
  "${ARGO_DIR}/postgres-cluster.yaml"

require_matches \
  "Agents chart values must use the CNPG-generated Agents database secret after the database cutover" \
  'name: agents-db-next-app' \
  "${ARGO_DIR}/values.yaml"

require_matches \
  "Agents Memory primitive must use the CNPG-generated Agents database secret after the database cutover" \
  'name: agents-db-next-app' \
  "${ARGO_DIR}/agents-primitives-memory.yaml"

fail_if_matches \
  "Agents GitOps must not keep the old database compatibility alias secret after the Agents-owned database cutover" \
  'agents-db-app' \
  "${ARGO_DIR}/values.yaml" \
  "${ARGO_DIR}/agents-primitives-memory.yaml"

if ! matches_multiline 'services:\n\s+- name: agents\n\s+port: 80' "${ARGO_DIR}/ingressroute-agents-api.yaml"; then
  echo "Agents extraction boundary violation: canonical agents.k8s.proompteng.ai IngressRoute must target the Agents service." >&2
  exit 1
fi

fail_if_path_exists \
  "Agents GitOps must not retain the Jangar-host compatibility Agents IngressRoute after Jangar browser callers use the canonical Agents API host" \
  "${ARGO_DIR}/ingressroute-jangar-agents-api.yaml"

fail_if_matches \
  "Agents GitOps kustomization must not include the removed Jangar-host compatibility Agents IngressRoute" \
  'ingressroute-jangar-agents-api\.yaml' \
  "${ARGO_DIR}/kustomization.yaml"

fail_if_matches \
  "Agents GitOps and chart values must not keep the Jangar browser origin as an Agents CORS compatibility bridge" \
  'jangar\.k8s\.proompteng\.ai' \
  "${ARGO_DIR}" \
  "${CHART_DIR}"

if matches_multiline 'kubernetesCRD:\n\s+enabled:\s*false' "${TRAEFIK_VALUES}"; then
  echo "Agents extraction boundary violation: Traefik GitOps must not disable the Kubernetes CRD provider required for Agents direct IngressRoute ownership." >&2
  exit 1
fi

require_matches \
  "Traefik wildcard certificate reflection must allow the Agents namespace for the direct Agents API IngressRoute TLS secret" \
  'reflection-allowed-namespaces:.*(^|[^a-z0-9-])agents([^a-z0-9-]|$)' \
  "${ROOT_DIR}/argocd/applications/traefik/k8s-proompteng-ai-certificate.yaml"

require_matches \
  "Traefik wildcard certificate auto-reflection must target the Agents namespace for the direct Agents API IngressRoute TLS secret" \
  'reflection-auto-namespaces:.*(^|[^a-z0-9-])agents([^a-z0-9-]|$)' \
  "${ROOT_DIR}/argocd/applications/traefik/k8s-proompteng-ai-certificate.yaml"

fail_if_matches \
  "services/agents must not import or package Jangar-local runner paths" \
  'services/jangar|/app/services/jangar|codex-implement' \
  "${ROOT_DIR}/services/agents/src" \
  "${ROOT_DIR}/services/agents/package.json" \
  "${ROOT_DIR}/services/agents/Dockerfile" \
  "${ROOT_DIR}/services/agents/Dockerfile.codex-runner"

fail_if_matches \
  "Agents runtime subscribers must not consume legacy workflow, Argo workflow, or workflow_comms agent-message subjects" \
  'workflow_comms\.agent_messages|legacy_workflow_comms|workflow\.>|agents\.workflow\.>|argo\.workflow|parts\[[0-9]+\] === .workflow.|parts\[[0-9]+\] === .argo.' \
  "${ROOT_DIR}/services/agents/src/server/agent-comms-subscriber.ts" \
  "${ROOT_DIR}/services/agents/src/server/integrations-config.ts" \
  "${ROOT_DIR}/charts/agents" \
  "${ROOT_DIR}/argocd/applications/agents"

fail_if_matches \
  "Jangar must not create or type the retired workflow_comms agent-message store after Agents owns agent-message storage" \
  'workflow_comms\.agent_messages|WorkflowCommsAgentMessage|workflow_agent_messages_' \
  "${ROOT_DIR}/services/jangar/src/server/db.ts" \
  "${ROOT_DIR}/services/jangar/src/server/migrations/20251229_workflow_comms_agent_messages.ts"

fail_if_matches \
  "Agents controller must not derive runner goals from deprecated AgentRun parameter aliases" \
  'goalObjective|goalTokenBudget' \
  "${ROOT_DIR}/services/agents/src/server/agents-controller" \
  "${ROOT_DIR}/services/agents/src/server/v1" \
  "${ROOT_DIR}/docs/agents/agentrun-creation-guide.md"

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
  "Agents GitOps must not consume legacy Argo workflow completion topics after AgentRun-native completion ingestion" \
  'argo\.workflows\.completions|workflow-completions|argo-workflows-completions-topic' \
  "${ROOT_DIR}/argocd/applications/agents"

fail_if_matches \
  "Jangar database manifests must not reflect Jangar DB credentials into the Agents namespace" \
  'reflection-(allowed|auto)-namespaces:.*(^|[^a-z0-9-])agents([^a-z0-9-]|$)' \
  "${ROOT_DIR}/argocd/applications/jangar/postgres-cluster.yaml"

fail_if_matches \
  "Jangar GitOps must not point Codex execution back at Facteur or legacy Codex orchestrations" \
  'FACTEUR_INTERNAL_URL|codex-autonomous|github-codex-implementation' \
  "${ROOT_DIR}/argocd/applications/jangar"

require_matches \
  "Jangar domain consumer must configure Agents-owned Codex rerun orchestration with AGENTS_* env names" \
  'AGENTS_CODEX_RERUN_ORCHESTRATION' \
  "${ROOT_DIR}/argocd/applications/jangar/deployment.yaml"

require_matches \
  "Jangar domain consumer must configure Agents-owned system-improvement orchestration with AGENTS_* env names" \
  'AGENTS_SYSTEM_IMPROVEMENT_ORCHESTRATION' \
  "${ROOT_DIR}/argocd/applications/jangar/deployment.yaml"

fail_if_matches \
  "Jangar GitOps must not publish Agents-owned orchestration settings under JANGAR_* names after the Agents orchestration cutover" \
  'JANGAR_CODEX_RERUN_ORCHESTRATION|JANGAR_SYSTEM_IMPROVEMENT_ORCHESTRATION' \
  "${ROOT_DIR}/argocd/applications/jangar/deployment.yaml"

fail_if_matches \
  "Jangar source and runbooks must not accept Agents-owned orchestration settings under legacy JANGAR_* env aliases" \
  'JANGAR_CODEX_RERUN_ORCHESTRATION|JANGAR_SYSTEM_IMPROVEMENT_ORCHESTRATION' \
  "${ROOT_DIR}/services/jangar/src/server/codex-judge-config.ts" \
  "${ROOT_DIR}/docs/agents/runbooks.md" \
  "${ROOT_DIR}/docs/jangar/autonomous-codex-end-to-end-design.md"

fail_if_matches \
  "Jangar GitOps must not ship legacy Codex workflow service accounts or RBAC" \
  'codex-workflow-rbac|name: codex-workflow|serviceAccountName: codex-workflow' \
  "${ROOT_DIR}/argocd/applications/jangar"

fail_if_matches \
  "Jangar Codex judge must not submit reruns through Facteur task ingress" \
  'facteurBaseUrl|FACTEUR_INTERNAL_URL|/codex/tasks|CodexTaskSchema' \
  "${ROOT_DIR}/services/jangar/src/server/codex-judge.ts" \
  "${ROOT_DIR}/services/jangar/src/server/codex-judge-config.ts"

fail_if_path_exists \
  "Jangar must not expose legacy Codex notify/run-complete callback routes after Agents owns callback ingestion" \
  "${ROOT_DIR}/services/jangar/src/routes/api/codex/notify.tsx" \
  "${ROOT_DIR}/services/jangar/src/routes/api/codex/run-complete.tsx" \
  "${ROOT_DIR}/services/jangar/src/routes/api/codex/notify.test.tsx" \
  "${ROOT_DIR}/services/jangar/src/routes/api/codex/run-complete.test.tsx"

fail_if_matches \
  "Jangar must not proxy Codex notify/run-complete callbacks after Agents owns Codex callback ingestion" \
  'submitCodexCallbackToAgentsService|AgentsCodexCallbackSubmitter|handleNotify|handleRunComplete' \
  "${ROOT_DIR}/services/jangar/src/server/agents-service-client.ts"

fail_if_matches \
  "Jangar deploy verifier must read Agents control-plane status through the Agents service, not svc/jangar proxy routes" \
  "namespaces/jangar/services/jangar|defaultControlPlaneServiceName = 'jangar'|statusServiceName" \
  "${ROOT_DIR}/packages/scripts/src/jangar/verify-deployment.ts"

fail_if_matches \
  "Jangar market-context dispatch must submit AgentRuns through the Agents service boundary, not direct Kubernetes apply or raw CRD schemas" \
  "createKubernetesClient|RESOURCE_MAP\\.AgentRun|\\.apply\\(|agents\\.proompteng\\.ai/v1alpha1|kind: 'AgentRun'|kind: \"AgentRun\"" \
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
  'createKubernetesClient|RESOURCE_MAP\.(AgentRun|OrchestrationRun)|agents\.proompteng\.ai/v1alpha1|orchestration\.proompteng\.ai/v1alpha1' \
  "${ROOT_DIR}/services/jangar/src/server/supporting-primitives-swarm-analysis.ts"

fail_if_path_exists \
  "Jangar must not retain the schedule-runner implementation after Agents owns schedule reconciliation" \
  "${ROOT_DIR}/services/jangar/src/server/supporting-primitives-schedule-runner.ts"

fail_if_matches \
  "Jangar must not retain schedule-runner image, service-account, or fire-time env ownership" \
  'JANGAR_SCHEDULE_RUNNER|scheduleRunnerImage|scheduleRunnerNodeSelector|scheduleRunnerAdmission|buildScheduleRunnerCommand' \
  "${ROOT_DIR}/services/jangar/src" \
  "${ROOT_DIR}/services/jangar/README.md"

fail_if_matches \
  "Jangar material-reentry Swarm reconciler must consume Swarms through the Agents service boundary" \
  'RESOURCE_MAP\.Swarm|startResourceWatch|createKubernetesClient|kube\.list' \
  "${ROOT_DIR}/services/jangar/src/server/supporting-primitives-material-reentry-swarm-reconciler.ts"

fail_if_matches \
  "Jangar primitive policy validation must read ApprovalPolicy, Budget, and SecretBinding through the Agents service boundary" \
  'RESOURCE_MAP\.(ApprovalPolicy|Budget|SecretBinding)|KubernetesClient|kube\.get' \
  "${ROOT_DIR}/services/jangar/src/server/primitives-policy.ts"

fail_if_matches \
  "Jangar memory provider must read Memory resources through the Agents service boundary" \
  'RESOURCE_MAP\.Memory|memories\.agents\.proompteng\.ai' \
  "${ROOT_DIR}/services/jangar/src/server/memory-provider.ts"

fail_if_matches \
  "Jangar material-reentry requirement publisher must submit Signals through the Agents service boundary" \
  'kube\.apply|createKubernetesClient|RESOURCE_MAP\.Signal' \
  "${ROOT_DIR}/services/jangar/src/server/supporting-primitives-material-reentry-requirements.ts"

fail_if_matches \
  "Jangar must call the Agents service boundary instead of importing Agents package internals" \
  '@proompteng/agents' \
  "${ROOT_DIR}/services/jangar/package.json" \
  "${ROOT_DIR}/services/jangar/src" \
  "${ROOT_DIR}/services/jangar/tsconfig.json" \
  "${ROOT_DIR}/services/jangar/tsconfig.oxlint.json" \
  "${ROOT_DIR}/services/jangar/vitest.config.ts"

fail_if_path_exists \
  "Jangar must not copy or embed the Agents agentctl proto after Agents owns the gRPC surface" \
  "${ROOT_DIR}/services/jangar/scripts/copy-agentctl-proto.ts"

fail_if_matches \
  "Jangar build paths must not copy services/agents/agentctl or require embedded agentctl protos" \
  'services/agents/agentctl|copy-agentctl-proto|copy:grpc-proto|agentctl\.proto' \
  "${ROOT_DIR}/.github/workflows/jangar-build-push.yaml" \
  "${ROOT_DIR}/packages/scripts/src/jangar" \
  "${ROOT_DIR}/services/jangar/package.json" \
  "${ROOT_DIR}/services/jangar/Dockerfile" \
  "${ROOT_DIR}/services/jangar/scripts"

fail_if_matches \
  "Jangar runtime/docs must not advertise Jangar-owned agentctl gRPC after Agents owns the service" \
  'agentctlGrpc|agentctl gRPC|JANGAR_GRPC|AgentctlService|agentctl talks to Jangar|agentctl-grpc' \
  "${ROOT_DIR}/services/jangar/README.md" \
  "${ROOT_DIR}/docs/jangar/application-architecture.md" \
  "${ROOT_DIR}/services/jangar/src/server"

fail_if_matches \
  "Jangar browser control-plane routes must stay read-only for generic Agents resources after Agents owns mutation APIs" \
  'Run agent|Create spec|Save ImplementationSpec|Delete selected|deletePrimitiveResource|AGENTS_AGENT_RUNS_API_PATH|AGENTS_CONTROL_PLANE_API_BASE.*/resource|kind: .ImplementationSpec.|kind: .AgentRun.' \
  "${ROOT_DIR}/services/jangar/src/routes/control-plane"

fail_if_matches \
  "Jangar browser data helpers must not expose generic Agents mutation helpers after Agents owns mutation APIs" \
  'fetchAgentOptions|AgentOption|deletePrimitiveResource|fetchPrimitive(List|Detail|Events|ControlPlaneStatus)|Primitive(List|Detail|Events)Result|AGENTS_AGENT_RUNS_API_PATH|AGENTS_CONTROL_PLANE_API_BASE|method: .DELETE.' \
  "${ROOT_DIR}/services/jangar/src/data/agents-control-plane.ts" \
  "${ROOT_DIR}/services/jangar/src/data/agents-api-paths.ts"

fail_if_matches \
  "Jangar runtime must not expose removed Agents controller profiles" \
  'AGENTS_SERVER_PROFILE|agents-control-plane|agents-controllers' \
  "${ROOT_DIR}/services/jangar/src/server/runtime-profile.ts"

fail_if_matches \
  "Jangar runtime identity must not be switchable by leaked Agents image or runtime env" \
  'AGENTS_RUNTIME_SERVICE|AGENTS_GITOPS_REVISION|AGENTS_RUNTIME_IMAGE|AGENTS_IMAGE' \
  "${ROOT_DIR}/services/jangar/src/server/runtime-identity.ts" \
  "${ROOT_DIR}/services/jangar/src/routes/health.tsx" \
  "${ROOT_DIR}/services/jangar/src/routes/ready.tsx"

fail_if_matches \
  "Jangar whitepaper finalizer must not use AGENTS_NAMESPACE as a namespace alias after Agents owns its runtime env" \
  'AGENTS_NAMESPACE' \
  "${ROOT_DIR}/services/jangar/src/server/whitepaper-finalize-consumer.ts"

fail_if_matches \
  "Jangar runtime and GitOps must not ship the removed agent-comms subscriber toggle after Agents owns the comms runtime" \
  'JANGAR_AGENT_COMMS_SUBSCRIBER_DISABLED' \
  "${ROOT_DIR}/services/jangar" \
  "${ROOT_DIR}/argocd/applications/jangar"

fail_if_matches \
  "Jangar runtime must not expose removed Agents controller enablement flags" \
  'JANGAR_AGENTS_CONTROLLER_ENABLED|JANGAR_ORCHESTRATION_CONTROLLER_ENABLED|JANGAR_SUPPORTING_CONTROLLER_ENABLED|JANGAR_PRIMITIVES_RECONCILER' \
  "${ROOT_DIR}/services/jangar/src/server/control-plane-config.ts" \
  "${ROOT_DIR}/services/jangar/Dockerfile" \
  "${ROOT_DIR}/services/jangar/playwright.config.ts" \
  "${ROOT_DIR}/services/jangar/scripts/openwebui-e2e.sh" \
  "${ROOT_DIR}/argocd/applications/jangar"

fail_if_matches \
  "Jangar docs must not advertise removed Agents controller runtime config" \
  'controller-runtime-config|JANGAR_AGENTS_CONTROLLER_' \
  "${ROOT_DIR}/services/jangar/README.md" \
  "${ROOT_DIR}/docs/jangar/application-architecture.md"

fail_if_matches \
  "Current Agents docs must not point controller, leader-election, retention, or runner-image ownership back to Jangar" \
  'JANGAR_AGENT_RUNNER_IMAGE|JANGAR_AGENT_IMAGE|JANGAR_LEADER_ELECTION|JANGAR_AGENTS_CONTROLLER_|services/jangar/src/server/agents-controller|codex-implement|Jangar is the control plane|Jangar controllers|Jangar image' \
  "${ROOT_DIR}/docs/agents/jangar-controller-design.md" \
  "${ROOT_DIR}/docs/agents/leader-election-design.md" \
  "${ROOT_DIR}/docs/agents/agent-run-retention-design.md" \
  "${ROOT_DIR}/docs/agents/agentrun-creation-guide.md" \
  "${ROOT_DIR}/docs/agents/runbooks.md"

fail_if_matches \
  "Jangar runtime must not own generic Agents runner image selection" \
  'JANGAR_AGENT_RUNNER_IMAGE|JANGAR_AGENT_IMAGE|defaultWorkloadImage|resolveDefaultWorkloadImage' \
  "${ROOT_DIR}/services/jangar/src/server/supporting-primitives-config.ts" \
  "${ROOT_DIR}/services/jangar/src/server/supporting-primitives-swarm-config.ts" \
  "${ROOT_DIR}/services/jangar/README.md"

fail_if_matches \
  "Agents controller runtime must not accept legacy generic runner image aliases after runner image ownership moved to AGENTS_AGENT_RUNNER_IMAGE" \
  'AGENTS_AGENT_IMAGE|JANGAR_AGENT_RUNNER_IMAGE|JANGAR_AGENT_IMAGE' \
  "${ROOT_DIR}/services/agents/src/server/agents-controller/runtime-config.ts" \
  "${ROOT_DIR}/services/agents/src/server/agents-controller/job-runtime.ts" \
  "${ROOT_DIR}/services/agents/src/server/agents-controller/agent-run-reconciler.ts" \
  "${ROOT_DIR}/services/agents/src/server/agents-controller/workflow-reconciler.ts"

fail_if_path_exists \
  "Jangar must not retain Agents controller runtime config after the controller extraction" \
  "${ROOT_DIR}/services/jangar/src/server/controller-runtime-config.ts"

fail_if_path_exists \
  "Jangar must not retain broad AGENTS/JANGAR env compatibility after Agents owns its runtime" \
  "${ROOT_DIR}/services/jangar/src/server/env-compat.ts"

fail_if_matches \
  "Jangar runtime must not install broad AGENTS/JANGAR env compatibility after Agents owns its runtime" \
  'installJangarEnvCompatibility|toAgentsEnvName|toJangarEnvName' \
  "${ROOT_DIR}/services/jangar/src"

fail_if_path_exists \
  "Jangar must not retain legacy generic Agents /api/control-plane API compatibility aliases" \
  "${ROOT_DIR}/services/jangar/src/routes/api/control-plane/agent-events.ts" \
  "${ROOT_DIR}/services/jangar/src/routes/api/control-plane/agent-runs.ts" \
  "${ROOT_DIR}/services/jangar/src/routes/api/control-plane/events.ts" \
  "${ROOT_DIR}/services/jangar/src/routes/api/control-plane/logs.ts" \
  "${ROOT_DIR}/services/jangar/src/routes/api/control-plane/resource.ts" \
  "${ROOT_DIR}/services/jangar/src/routes/api/control-plane/resources.ts" \
  "${ROOT_DIR}/services/jangar/src/routes/api/control-plane/status.ts" \
  "${ROOT_DIR}/services/jangar/src/routes/api/control-plane/stream.ts" \
  "${ROOT_DIR}/services/jangar/src/routes/api/control-plane/implementation-sources/webhooks"

fail_if_path_exists \
  "Jangar must not retain generic Agents browser control-plane route ownership after the Agents UI/API extraction" \
  "${ROOT_DIR}/services/jangar/src/routes/control-plane"

fail_if_path_exists \
  "Jangar must not retain generic Agents browser control-plane components after the Agents UI/API extraction" \
  "${ROOT_DIR}/services/jangar/src/components/agents-control-plane.tsx" \
  "${ROOT_DIR}/services/jangar/src/components/agents-control-plane-search.ts" \
  "${ROOT_DIR}/services/jangar/src/components/agents-control-plane-redirect.tsx" \
  "${ROOT_DIR}/services/jangar/src/components/agents-control-plane-primitives.tsx" \
  "${ROOT_DIR}/services/jangar/src/components/agents-control-plane-stream.tsx" \
  "${ROOT_DIR}/services/jangar/src/components/agents-control-plane-status.tsx" \
  "${ROOT_DIR}/services/jangar/src/components/agents-control-plane-overview.tsx"

fail_if_matches \
  "Jangar app navigation must not link to generic Agents /control-plane pages after Agents owns that browser surface" \
  '/control-plane/(implementation-specs|runs|agents|agent-runs|agent-providers|tools|tool-runs|orchestrations|orchestration-runs)' \
  "${ROOT_DIR}/services/jangar/src/components/app-sidebar.tsx" \
  "${ROOT_DIR}/services/jangar/src/components/app-shell.tsx"

fail_if_matches \
  "Jangar browser and server code must use canonical Agents APIs instead of legacy /api/control-plane aliases" \
  '/api/control-plane/(agent-events|agent-runs|events|implementation-sources|logs|resource|resources|status|stream)' \
  "${ROOT_DIR}/services/jangar/src" \
  "${ROOT_DIR}/services/jangar/README.md" \
  "${ROOT_DIR}/packages/scripts/src/jangar"

fail_if_matches \
  "Jangar workflow status must not reuse Agents controller namespace envs" \
  'JANGAR_AGENTS_CONTROLLER_NAMESPACES|AGENTS_ORCHESTRATION_CONTROLLER|AGENTS_SUPPORTING_CONTROLLER|AGENTS_PRIMITIVES_RECONCILER|AGENTS_RBAC_CLUSTER_SCOPED' \
  "${ROOT_DIR}/services/jangar/src/server/control-plane-workflows.ts" \
  "${ROOT_DIR}/services/jangar/src/server/namespace-scope.ts" \
  "${ROOT_DIR}/services/jangar/src/server/runtime-validation.ts"

fail_if_matches \
  "Jangar kube helper must not carry Agents CRD aliases after the control-plane extraction" \
  'agents\.proompteng\.ai|tools\.proompteng\.ai|orchestration\.proompteng\.ai|approvals\.proompteng\.ai|budgets\.proompteng\.ai|security\.proompteng\.ai|signals\.proompteng\.ai|schedules\.proompteng\.ai|swarm\.proompteng\.ai|artifacts\.proompteng\.ai|workspaces\.proompteng\.ai' \
  "${ROOT_DIR}/services/jangar/src/server/primitives-kube.ts"

fail_if_path_exists \
  "Jangar must not retain copied Agents kube watch helpers" \
  "${ROOT_DIR}/services/jangar/src/server/kube-watch.ts" \
  "${ROOT_DIR}/services/jangar/src/server/primitives-watch.ts"

fail_if_matches \
  "Jangar must not create or write Agents-owned control-plane database tables" \
  'agents_control_plane|agent_run_idempotency_keys|CREATE TABLE IF NOT EXISTS agent_runs|CREATE TABLE IF NOT EXISTS orchestration_runs|CREATE TABLE IF NOT EXISTS memory_resources' \
  "${ROOT_DIR}/services/jangar/src/server/db.ts" \
  "${ROOT_DIR}/services/jangar/src/server/control-plane-heartbeat-store.ts" \
  "${ROOT_DIR}/services/jangar/src/server/control-plane-clearance-market.ts" \
  "${ROOT_DIR}/services/jangar/src/server/migrations"

fail_if_matches \
  "Jangar database typing must not reintroduce Agents-owned table contracts after migration ownership moved to services/agents" \
  'agent_run_idempotency_keys|agents_control_plane_cache|agents_control_plane_component_heartbeats|agents_comms|workflow_comms|memory_resources|orchestration_runs' \
  "${ROOT_DIR}/services/jangar/src/server/db.ts"

fail_if_matches \
  "Agents deploy tooling must not recreate database compatibility alias secrets; the agents-db-app secret must already exist" \
  'AGENTS_CREATE_DB_SECRET_ALIAS|compat-source-secret|buildDatabaseSecretAliasManifest|resolveDatabaseSecretSource|Created compatibility database secret' \
  "${ROOT_DIR}/packages/scripts/src/agents"

fail_if_matches \
  "Agents runtime must not copy or read the retired workflow_comms agent-message store after Agents owns agent-message storage" \
  'workflow_comms\.agent_messages' \
  "${ROOT_DIR}/services/agents/src/server"

fail_if_matches \
  "Agents runtime must not expose workflow-shaped agent-message identity fields after AgentRun owns the public contract" \
  'workflowUid|workflow_uid|workflowName|workflow_name|workflowNamespace|workflow_namespace|workflowStage|workflow_stage|workflowStep|workflow_step' \
  "${ROOT_DIR}/services/agents/src/server/agent-messages-api.ts" \
  "${ROOT_DIR}/services/agents/src/server/agent-messages-store.ts" \
  "${ROOT_DIR}/services/agents/src/server/agent-comms-subscriber.ts" \
  "${ROOT_DIR}/services/agents/src/server/codex-callbacks.ts" \
  "${ROOT_DIR}/services/agents/src/routes/api/agents/events.ts" \
  "${ROOT_DIR}/services/agents/src/server/db.ts" \
  "${ROOT_DIR}/services/agents/src/server/migrations"

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

fail_if_matches \
  "Graf must consume Agents AgentRuns directly, not legacy Argo workflow compatibility names" \
  'argoWorkflowName|argoPollTimeoutSeconds|SubmitArgoWorkflow|CompletedArgoWorkflow|submitArgoWorkflow|waitForArgoWorkflow|workflowNamePrefix|ARGO_WORKFLOW_|ARGO_SERVICE_ACCOUNT_TOKEN_PATH|autoResearch\.argoWorkflow' \
  "${ROOT_DIR}/services/graf/src/main/kotlin" \
  "${ROOT_DIR}/services/graf/src/test/kotlin"

rendered_chart="$(mktemp)"
rendered_argo="$(mktemp)"
cleanup() {
  rm -f "${rendered_chart}" "${rendered_argo}"
}
trap cleanup EXIT

helm template agents "${CHART_DIR}" --namespace agents > "${rendered_chart}"
kubectl kustomize "${ARGO_DIR}" --enable-helm > "${rendered_argo}"

rendered_forbidden='JANGAR_|jangar-db-app|jangar-db-ca|/etc/jangar|lab/jangar|/app/services/jangar|services/jangar|codex-implement|consumerGroup: jangar|AGENTS_TORGHUT_STATUS_|AGENTS_WHITEPAPER_FINALIZE_'
agents_runtime_forbidden='codex-universal|ghcr.io/openai/codex-universal'
fail_if_matches "rendered Helm chart must use Agents-owned images, env, DB secret, and runner paths" "${rendered_forbidden}" "${rendered_chart}"
fail_if_matches "rendered Agents GitOps app must use Agents-owned images, env, DB secret, and runner paths" "${rendered_forbidden}" "${rendered_argo}"
fail_if_matches "rendered Agents GitOps app must use the chart-managed agents-codex-runner path" "${agents_runtime_forbidden}" "${rendered_argo}"

if ! matches_multiline 'name: AGENTS_SWARM_PRIMITIVE_ENABLED\n\s+value: "true"' "${rendered_argo}"; then
  echo "Agents extraction boundary violation: rendered Agents GitOps app must enable the Swarm primitive when it ships the supporting controller." >&2
  exit 1
fi

if ! matches_multiline 'name: AGENTS_SERVER_PROFILE\n\s+value: agents-control-plane' "${rendered_argo}"; then
  echo "Agents extraction boundary violation: rendered Agents control-plane deployment must use the agents-control-plane runtime profile." >&2
  exit 1
fi

if ! matches_multiline 'name: AGENTS_SERVER_PROFILE\n\s+value: agents-controllers' "${rendered_argo}"; then
  echo "Agents extraction boundary violation: rendered Agents controllers deployment must use the agents-controllers runtime profile." >&2
  exit 1
fi

if ! matches_multiline 'apiGroups:\n\s+- swarm\.proompteng\.ai\n\s+resources:\n\s+- swarms' "${rendered_argo}"; then
  echo "Agents extraction boundary violation: rendered Agents GitOps app must grant Swarm RBAC when the Swarm primitive is enabled." >&2
  exit 1
fi
