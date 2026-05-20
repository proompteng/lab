import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'bun:test'

const guardScript = () => readFileSync(resolve(process.cwd(), 'scripts/agents/guard-extraction-boundaries.sh'), 'utf8')
const agentsCiWorkflow = () => readFileSync(resolve(process.cwd(), '.github/workflows/agents-ci.yml'), 'utf8')

const protectedBoundaryTriggerPaths = [
  'apps/froussard/src/**',
  'argocd/applications/agents/**',
  'argocd/applications/argo-workflows/**',
  'argocd/applications/facteur/**',
  'argocd/applications/froussard/**',
  'argocd/applications/graf/**',
  'argocd/applications/traefik/values.yaml',
  'argocd/applications/torghut/**',
  'charts/agents/**',
  'docs/agents/**',
  'docs/autonomous-codex-design.md',
  'docs/graf-codex-research.md',
  'docs/runbooks/codex-docker.md',
  'docs/runbooks/kafka-broker-storage-recovery.md',
  'docs/torghut/whitepaper-research-workflow.md',
  'docs/torghut/design-system/v5/12-dspy-framework-adoption-for-quant-llm-autonomous-trading-2026-02-25.md',
  'packages/scripts/src/agents/**',
  'proto/proompteng/facteur/v1/contract.proto',
  'services/agents/**',
  'services/facteur/README.md',
  'services/facteur/cmd/**',
  'services/facteur/config/**',
  'services/facteur/internal/**',
  'services/graf/src/main/kotlin/**',
  'services/graf/src/test/kotlin/**',
  'services/graf/README.md',
  'services/graf/build.gradle.kts',
  'services/torghut/app/main.py',
  'services/torghut/app/config.py',
  'services/torghut/app/trading/llm/**',
  'services/torghut/app/whitepapers/**',
  'services/torghut/scripts/run_dspy_workflow.py',
  'services/torghut/tests/test_live_config_manifest_contract.py',
  'services/torghut/tests/test_llm_dspy_workflow.py',
  'services/torghut/tests/test_run_dspy_workflow.py',
  'services/torghut/tests/test_whitepaper_api.py',
  'services/torghut/tests/test_whitepaper_workflow.py',
  'scripts/agents/**',
]

const workflowTriggerPathCount = (workflow: string, path: string) => {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return workflow.match(new RegExp(`^\\s+- '${escapedPath}'$`, 'gm'))?.length ?? 0
}

describe('agents extraction boundary guard', () => {
  it('runs from Agents CI when protected extraction boundary paths change', () => {
    const workflow = agentsCiWorkflow()

    expect(workflow).toContain('run: scripts/agents/guard-extraction-boundaries.sh')
    for (const path of protectedBoundaryTriggerPaths) {
      expect(workflowTriggerPathCount(workflow, path)).toBe(2)
    }
  })

  it('does not fail on colocated tests that assert forbidden runtime strings are absent', () => {
    const content = guardScript()

    expect(content).toContain("--glob '!**/__tests__/**'")
    expect(content).toContain("--glob '!**/*.test.*'")
    expect(content).toContain('fail_if_matches_including_tests')
  })

  it('guards legacy completion topics and reflected Jangar database secrets out of Agents runtime', () => {
    const content = guardScript()

    expect(content).toContain('ingressroute-agents-api\\.yaml')
    expect(content).toContain('agents\\.k8s\\.proompteng\\.ai')
    expect(content).toContain('name: agents-db-next')
    expect(content).toContain('name: agents-db-next-app')
    expect(content).toContain('database: agents')
    expect(content).toContain('CREATE EXTENSION IF NOT EXISTS vector')
    expect(content).toContain('jangar\\.k8s\\.proompteng\\.ai')
    expect(content).toContain('Agents GitOps must not keep the old database compatibility alias secret')
    expect(content).toContain('Agents kind chart values must use the CNPG-compatible Agents database secret')
    expect(content).toContain('Agents kind e2e must default to the Agents-owned database application secret')
    expect(content).toContain('proxyAgentsServiceRequest|buildAgentsServiceProxyUrl')
    expect(content).toContain('Jangar-host compatibility Agents IngressRoute')
    expect(content).toContain('ingressroute-jangar-agents-api\\.yaml')
    expect(content).toContain('workflow_comms\\.agent_messages|legacy_workflow_comms')
    expect(content).toContain('NATS agent-comms GitOps must expose only Agents-native subjects')
    expect(content).toContain('Generic Agents Codex providers must not grant trading or broker MCP tooling')
    expect(content).toContain(
      'Agents Graf provider must not preserve legacy AutoResearch or Argo workflow artifact defaults',
    )
    expect(content).toContain('Graf service artifact runtime must use Agents-owned artifact env names and bucket')
    expect(content).toContain(
      'Graf artifact config must not keep legacy MINIO_* environment fallbacks after Agents owns artifacts',
    )
    expect(content).toContain(
      'Jangar memory provider must use Agents memory operation APIs instead of Agents-owned Secrets or DB tables',
    )
    expect(content).toContain(
      'Shared Argo Workflows GitOps must not retain generic Agents WorkflowTemplate or Argo completion ingestion manifests',
    )
    expect(content).toContain('Shared Argo Workflows GitOps must not retain the retired Codex Docker privileged policy')
    expect(content).toContain('Froussard must not retain the legacy Argo workflow run-complete Kafka replay helper')
    expect(content).toContain('Observability must not track retired Argo workflow completion Kafka topics')
    expect(content).toContain('Active Jangar docs must not describe the retired Argo workflow completion bridge')
    expect(content).toContain('ALPACA_|mcp_servers\\.alpaca|alpaca-mcp')
    expect(content).toContain('Domain AgentRun swarm producers must use AgentRun-native NATS subject prefixes')
    expect(content).toContain(
      'natsSubjectPrefix:\\s*workflow|subjectPrefix:\\s*workflow|workflow\\.general\\.requirement',
    )
    expect(content).toContain('WorkflowCommsAgentMessage|workflow_agent_messages_')
    expect(content).toContain('AgentRun callback contracts must not export legacy workflow-shaped identity cleanup')
    expect(content).toContain('stripLegacyWorkflowIdentityFields')
    expect(content).toContain('goalObjective|goalTokenBudget')
    expect(content).toContain('argo\\.workflows\\.completions')
    expect(content).toContain('Jangar must not expose legacy Codex notify/run-complete callback routes')
    expect(content).toContain('Agents docs must not retain the domain-specific Torghut/Jangar swarm e2e runbook')
    expect(content).toContain('reflection-(allowed|auto)-namespaces')
    expect(content).toContain('jangar-db-ca')
    expect(content).toContain('AGENTS_CODEX_RERUN_ORCHESTRATION')
    expect(content).toContain('AGENTS_SYSTEM_IMPROVEMENT_ORCHESTRATION')
    expect(content).toContain('JANGAR_CODEX_RERUN_ORCHESTRATION|JANGAR_SYSTEM_IMPROVEMENT_ORCHESTRATION')
    expect(content).toContain('legacy generic runner image aliases')
    expect(content).toContain('AGENTS_AGENT_IMAGE|JANGAR_AGENT_RUNNER_IMAGE|JANGAR_AGENT_IMAGE')
    expect(content).toContain('runner-level NATS auth for legacy exec progress helpers')
    expect(content).toContain('live AgentProvider spec.secretEnv before the live CRD schema catches up')
    expect(content).toContain('Argo CD Application reads after control-plane extraction')
    expect(content).toContain('Agents chart design docs must not advertise retired Jangar-managed chart env names')
    expect(content).toContain('Agents CI workflow must not run for Jangar-owned source or docs changes')
    expect(content).toContain('Agents CI GitOps RBAC must not carry Jangar-specific role names')
    expect(content).toContain(
      'JANGAR_MIGRATIONS|JANGAR_GRPC_|JANGAR_CONTROL_PLANE_CACHE_ENABLED|JANGAR_AGENTS_CONTROLLER_AUTH_SECRET',
    )
    expect(content).toContain('legacy generic Agents /api/control-plane API compatibility aliases')
    expect(content).toContain('internal generic kind-string control-plane resource transport')
    expect(content).toContain(
      'typed v1 resource endpoints instead of generic /api/agents/control-plane resource selectors',
    )
    expect(content).toContain('typed resource routes must not retain a route-local typed resource helper shim')
    expect(content).toContain('typed resource routes must not request-rewrite')
    expect(content).toContain('copyRequestWithKind|toKindResourceUrl')
    expect(content).toContain('generic Agents browser control-plane route ownership')
    expect(content).toContain('generic Agents browser control-plane components')
    expect(content).toContain('services/jangar/src/components/agents-control-plane.tsx')
    expect(content).toContain('fetchPrimitive(List|Detail|Events|ControlPlaneStatus)')
    expect(content).toContain('Jangar app navigation must not link to generic Agents /control-plane pages')
    expect(content).toContain('supporting-primitives-schedule-catchup.ts')
    expect(content).toContain(
      '/api/control-plane/(agent-events|agent-runs|events|implementation-sources|logs|resource|resources|status|stream)',
    )
    expect(content).toContain('broad control-plane-resources-client module')
    expect(content).toContain('broad control-plane-resources-client package subpath')
    expect(content).toContain('agents-service-client')
    expect(content).toContain('dedicated /v1/agent-runs/resources contract')
    expect(content).toContain('v1 status and message APIs instead of web-internal /api/agents paths')
    expect(content).toContain('legacy /api/agents routes or route registrations')
    expect(content).toContain('domain-neutral')
    expect(content).toContain('Jangar/Torghut market-context AgentRun builders')
    expect(content).toContain('AGENTS_RUNTIME_SERVICE|AGENTS_GITOPS_REVISION|AGENTS_RUNTIME_IMAGE|AGENTS_IMAGE')
    expect(content).toContain('AGENTS_NAMESPACE')
    expect(content).toContain('JANGAR_AGENT_COMMS_SUBSCRIBER_DISABLED')
    expect(content).toContain('Jangar database typing must not reintroduce Agents-owned table contracts')
    expect(content).toContain('Agents deploy tooling must not recreate database compatibility alias secrets')
    expect(content).toContain('AGENTS_CREATE_DB_SECRET_ALIAS|compat-source-secret')
    expect(content).toContain('Agents must not expose legacy Codex notify/run-complete callback bridge')
    expect(content).toContain('api/agents/codex/(notify|run-complete)')
    expect(content).toContain('retired workflow_comms agent-message store')
    expect(content).toContain('Agents Codex NATS publisher must emit AgentRun-native identity only')
    expect(content).toContain('Jangar Codex judge source contract must use AgentRun-native runtime identity fields')
    expect(content).toContain('getRunByWorkflow|selectCodexJudgeRunByWorkflow')
    expect(content).toContain('updateArtifactsFromWorkflow|workflowTag')
    expect(content).toContain('retired GitHub issue Codex Kafka bridge')
    expect(content).toContain(
      'github\\.issues\\.codex\\.tasks|KAFKA_CODEX_TOPIC_STRUCTURED|CodexTaskSchema|toCodexTaskProto',
    )
    expect(content).toContain('/agent-runs/github-issues|codex_listener|codex-listen|froussardpb|CodexTask')
    expect(content).toContain('Jangar Codex judge current schema and queries must use AgentRun-native physical columns')
    expect(content).toContain('workflow_name|workflow_uid|workflow_namespace|codex_judge_runs_workflow')
    expect(content).toContain('workflow-shaped agent-message identity fields')
    expect(content).toContain('Agents implementation contracts must not normalize workflow-shaped stage aliases')
    expect(content).toContain('Torghut AgentRun producers must use Agents naming and service defaults')
    expect(content).toContain('retired workflow.general subjects')
    expect(content).toContain('Agents-owned controller witness design')
    expect(content).toContain('Jangar whitepaper fixtures for generic control-plane APIs')
    expect(content).toContain('domain-neutral fixtures')
    expect(content).toContain('registry\\.example/jangar|marco-silva-jangar')
    expect(content).toContain(
      'workflowUid|workflow_uid|workflowName|workflow_name|workflowNamespace|workflow_namespace',
    )
    expect(content).toContain('agents-control-plane runtime profile')
    expect(content).toContain('agents-controllers runtime profile')
  })
})
