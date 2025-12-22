import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')

const loadYaml = async <T = unknown>(relativePath: string): Promise<T> => {
  const absolutePath = resolve(repoRoot, relativePath)
  const content = await readFile(absolutePath, 'utf8')
  return YAML.parse(content) as T
}

interface WorkflowTemplate {
  spec?: {
    templates?: Array<{
      container?: {
        args?: string[]
      }
    }>
  }
}

describe('Codex Argo manifests', () => {
  it('decodes payloads inside Codex workflow templates before invoking the CLI', async () => {
    const templatePaths = ['argocd/applications/froussard/github-codex-implementation-workflow-template.yaml']

    for (const relativePath of templatePaths) {
      const template = await loadYaml<WorkflowTemplate>(relativePath)
      const implementTemplate = template.spec?.templates?.[0]
      const script: string | undefined = implementTemplate?.container?.args?.[2]
      expect(script, `missing bootstrap script for ${relativePath}`).toBeTruthy()
      expect(script, `workflow ${relativePath} does not decode payloads`).toContain('base64 --decode')
    }
  })
})
