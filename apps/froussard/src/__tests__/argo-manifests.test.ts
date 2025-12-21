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

interface SensorSpec {
  spec?: {
    triggers?: Array<{
      template?: {
        name?: string
        k8s?: {
          parameters?: Array<{
            dest?: string
            src?: {
              dataTemplate?: string
            }
          }>
        }
      }
    }>
  }
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
  it('base64-encodes Codex task payloads before submitting workflows', async () => {
    const sensor = await loadYaml<SensorSpec>('argocd/applications/froussard/github-codex-sensor.yaml')
    const triggers = sensor.spec?.triggers ?? []
    const triggerNames = ['implementation-workflow']

    for (const name of triggerNames) {
      const trigger = triggers.find((entry) => entry.template?.name === name)
      expect(trigger, `missing trigger ${name}`).toBeTruthy()
      const parameters = trigger?.template?.k8s?.parameters ?? []
      const destinations = ['spec.arguments.parameters.0.value', 'spec.arguments.parameters.1.value']

      for (const dest of destinations) {
        const param = parameters.find((entry) => entry.dest === dest)
        expect(param, `missing parameter ${dest} on ${name}`).toBeTruthy()
        expect(param?.src?.dataTemplate, `${name}:${dest} not encoded`).toMatch(/b64enc/)
      }
    }
  })

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
