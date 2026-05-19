import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const workflowTemplatePaths = [
  'argocd/applications/argo-workflows/jangar-approval-gate-workflowtemplate.yaml',
  'argocd/applications/argo-workflows/jangar-checkpoint-workflowtemplate.yaml',
  'argocd/applications/argo-workflows/jangar-memory-op-workflowtemplate.yaml',
  'argocd/applications/argo-workflows/jangar-signal-wait-workflowtemplate.yaml',
  'argocd/applications/argo-workflows/jangar-sub-orchestration-workflowtemplate.yaml',
]

const readRepoFile = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('Argo workflow primitive ownership', () => {
  it('runs generic primitive workflow scripts on the Agents controller image instead of Jangar', () => {
    const kustomization = readRepoFile('argocd/applications/argo-workflows/kustomization.yaml')

    expect(kustomization).toContain('name: registry.ide-newton.ts.net/lab/agents-controller')
    expect(kustomization).not.toContain('name: registry.ide-newton.ts.net/lab/jangar')

    for (const path of workflowTemplatePaths) {
      const manifest = readRepoFile(path)
      expect(manifest).toContain('image: registry.ide-newton.ts.net/lab/agents-controller')
      expect(manifest).not.toContain('image: registry.ide-newton.ts.net/lab/jangar')
      expect(manifest).not.toContain('/tmp/jangar-')
    }
  })

  it('keeps primitive workflow scripts within the Agents controller tool surface', () => {
    const combinedManifests = workflowTemplatePaths.map(readRepoFile).join('\n')

    expect(combinedManifests).not.toContain(' jq ')
    expect(combinedManifests).not.toContain('\njq ')
    expect(combinedManifests).toContain('/tmp/agents-checkpoint.mjs')
    expect(combinedManifests).toContain('/tmp/agents-memory-op.mjs')
  })
})
