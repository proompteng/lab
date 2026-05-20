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
  'argocd/applications/jangar/**',
  'argocd/applications/traefik/values.yaml',
  'charts/agents/**',
  'docs/agents/**',
  'docs/jangar/application-architecture.md',
  'packages/scripts/src/agents/**',
  'packages/scripts/src/jangar/verify-deployment.ts',
  'proto/proompteng/facteur/v1/contract.proto',
  'services/agents/**',
  'services/facteur/README.md',
  'services/facteur/cmd/**',
  'services/facteur/config/**',
  'services/facteur/internal/**',
  'services/graf/src/main/kotlin/**',
  'services/graf/src/test/kotlin/**',
  'services/jangar/**',
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
    expect(content).toContain('proxyAgentsServiceRequest|buildAgentsServiceProxyUrl')
    expect(content).toContain('Jangar-host compatibility Agents IngressRoute')
    expect(content).toContain('ingressroute-jangar-agents-api\\.yaml')
    expect(content).toContain('workflow_comms\\.agent_messages|legacy_workflow_comms')
    expect(content).toContain('WorkflowCommsAgentMessage|workflow_agent_messages_')
    expect(content).toContain('goalObjective|goalTokenBudget')
    expect(content).toContain('argo\\.workflows\\.completions')
    expect(content).toContain('Jangar must not expose legacy Codex notify/run-complete callback routes')
    expect(content).toContain('reflection-(allowed|auto)-namespaces')
    expect(content).toContain('jangar-db-ca')
    expect(content).toContain('AGENTS_CODEX_RERUN_ORCHESTRATION')
    expect(content).toContain('AGENTS_SYSTEM_IMPROVEMENT_ORCHESTRATION')
    expect(content).toContain('JANGAR_CODEX_RERUN_ORCHESTRATION|JANGAR_SYSTEM_IMPROVEMENT_ORCHESTRATION')
    expect(content).toContain('legacy generic runner image aliases')
    expect(content).toContain('AGENTS_AGENT_IMAGE|JANGAR_AGENT_RUNNER_IMAGE|JANGAR_AGENT_IMAGE')
    expect(content).toContain('legacy generic Agents /api/control-plane API compatibility aliases')
    expect(content).toContain('generic Agents browser control-plane route ownership')
    expect(content).toContain('generic Agents browser control-plane components')
    expect(content).toContain('services/jangar/src/components/agents-control-plane.tsx')
    expect(content).toContain('fetchPrimitive(List|Detail|Events|ControlPlaneStatus)')
    expect(content).toContain('Jangar app navigation must not link to generic Agents /control-plane pages')
    expect(content).toContain(
      '/api/control-plane/(agent-events|agent-runs|events|implementation-sources|logs|resource|resources|status|stream)',
    )
    expect(content).toContain('AGENTS_RUNTIME_SERVICE|AGENTS_GITOPS_REVISION|AGENTS_RUNTIME_IMAGE|AGENTS_IMAGE')
    expect(content).toContain('AGENTS_NAMESPACE')
    expect(content).toContain('JANGAR_AGENT_COMMS_SUBSCRIBER_DISABLED')
    expect(content).toContain('Jangar database typing must not reintroduce Agents-owned table contracts')
    expect(content).toContain('Agents deploy tooling must not recreate database compatibility alias secrets')
    expect(content).toContain('AGENTS_CREATE_DB_SECRET_ALIAS|compat-source-secret')
    expect(content).toContain('retired workflow_comms agent-message store')
    expect(content).toContain('agents-control-plane runtime profile')
    expect(content).toContain('agents-controllers runtime profile')
  })
})
