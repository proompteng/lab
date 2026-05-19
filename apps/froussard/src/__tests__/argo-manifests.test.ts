import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')

const readRepoFile = async (relativePath: string): Promise<string> => {
  const absolutePath = resolve(repoRoot, relativePath)
  return readFile(absolutePath, 'utf8')
}

describe('Codex Argo manifests', () => {
  it('does not ship legacy Codex WorkflowTemplates from the Froussard app', async () => {
    const kustomization = await readRepoFile('argocd/applications/froussard/kustomization.yaml')

    expect(kustomization).not.toContain('github-codex-implementation-workflow-template.yaml')
    expect(kustomization).not.toContain('codex-run-workflow-template-jangar.yaml')
    expect(kustomization).not.toContain('codex-autonomous-workflow-template.yaml')
    expect(kustomization).not.toContain('github-codex-post-deploy-workflow-template.yaml')
  })

  it('does not own generic Argo workflow completion ingestion', async () => {
    const kustomization = await readRepoFile('argocd/applications/froussard/kustomization.yaml')

    expect(kustomization).not.toContain('event-bus.yaml')
    expect(kustomization).not.toContain('workflow-completions')
    expect(kustomization).not.toContain('argo-workflows-completions-topic.yaml')
  })
})
