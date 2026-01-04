import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(__dirname, '../../../..')

const loadYamlDocs = async <T = unknown>(relativePath: string): Promise<T[]> => {
  const absolutePath = resolve(repoRoot, relativePath)
  const content = await readFile(absolutePath, 'utf8')
  const docs = YAML.parseAllDocuments(content)
  return docs.map((doc) => doc.toJSON() as T).filter(Boolean)
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
      const templates = await loadYamlDocs<WorkflowTemplate>(relativePath)
      const scripts = templates
        .map((template) => template.spec?.templates?.[0]?.container?.args?.[2])
        .filter((script): script is string => Boolean(script))
      expect(scripts.length, `missing bootstrap script for ${relativePath}`).toBeGreaterThan(0)
      expect(
        scripts.some((script) => script.includes('base64 --decode')),
        `workflow ${relativePath} does not decode payloads`,
      ).toBe(true)
    }
  })
})
