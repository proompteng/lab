import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const retiredRuntimePaths = [
  'argocd/applications/argo-workflows/agents-approval-gate-workflowtemplate.yaml',
  'argocd/applications/argo-workflows/agents-checkpoint-workflowtemplate.yaml',
  'argocd/applications/argo-workflows/agents-memory-op-workflowtemplate.yaml',
  'argocd/applications/argo-workflows/agents-signal-wait-workflowtemplate.yaml',
  'argocd/applications/argo-workflows/agents-sub-orchestration-workflowtemplate.yaml',
  'argocd/applications/argo-workflows/agents-embeddings-config.yaml',
  'argocd/applications/argo-workflows/event-bus.yaml',
  'argocd/applications/argo-workflows/workflow-completions-eventsource.yaml',
  'argocd/applications/argo-workflows/workflow-completions-sensor.yaml',
  'argocd/applications/argo-workflows/argo-workflows-completions-topic.yaml',
  'argocd/applications/argo-workflows/codex-docker-policy.yaml',
]

const readRepoFile = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
const repoPathExists = (path: string) => existsSync(resolve(process.cwd(), path))

describe('Argo workflow primitive ownership', () => {
  it('does not render Agents primitive runtime or workflow completion ingestion from the shared Argo app', () => {
    const kustomization = readRepoFile('argocd/applications/argo-workflows/kustomization.yaml')

    for (const path of retiredRuntimePaths) {
      expect(repoPathExists(path)).toBe(false)
      expect(kustomization).not.toContain(path.replace('argocd/applications/argo-workflows/', ''))
    }

    expect(kustomization).not.toContain('registry.ide-newton.ts.net/lab/agents-controller')
    expect(kustomization).not.toContain('argo-events')
    expect(kustomization).not.toContain('workflow-completions')
    expect(kustomization).not.toContain('argo-workflows-completions-topic')
    expect(kustomization).not.toContain('codex-docker-policy')
  })

  it('keeps Codex Workflow RBAC only for remaining domain-owned Argo workloads', () => {
    const kustomization = readRepoFile('argocd/applications/argo-workflows/kustomization.yaml')

    expect(kustomization).toContain('codex-workflow-serviceaccount.yaml')
    expect(kustomization).toContain('codex-workflow-rbac.yaml')
    expect(kustomization).toContain('codex-implementation-semaphore.yaml')
    expect(kustomization).not.toContain('agents-embeddings-config')
  })
})
