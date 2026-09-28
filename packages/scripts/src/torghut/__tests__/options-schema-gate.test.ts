import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import YAML from 'yaml'

import { repoRoot } from '../../shared/cli'

const optionsRoot = join(repoRoot, 'argocd/applications/torghut-options')
const deployments = ['archive', 'catalog', 'enricher']

test('gates promoted options workloads on the complete migration 0067 schema', () => {
  const gate = YAML.parse(readFileSync(join(optionsRoot, 'schema-gate-configmap.yaml'), 'utf8')) as {
    data?: Record<string, string>
  }
  const gateScript = gate.data?.['await-options-schema.py'] ?? ''

  expect(gateScript).toContain('torghut_options_archive_membership')
  expect(gateScript).toContain('ix_options_catalog_active_expiration_symbol')
  expect(gateScript).toContain('torghut_options_contract_archive_status')
  expect(gateScript).toContain('torghut_options_active_contract_catalog')
  expect(gateScript).toContain('migrations through 0067')

  for (const component of deployments) {
    const deployment = YAML.parse(readFileSync(join(optionsRoot, component, 'deployment.yaml'), 'utf8')) as {
      spec?: {
        template?: {
          spec?: {
            containers?: Array<{ image?: string }>
            initContainers?: Array<{
              command?: string[]
              env?: Array<{ name?: string; valueFrom?: { secretKeyRef?: { key?: string; name?: string } } }>
              image?: string
              name?: string
              volumeMounts?: Array<{ mountPath?: string; name?: string; readOnly?: boolean }>
            }>
            volumes?: Array<{ configMap?: { name?: string }; name?: string }>
          }
        }
      }
    }
    const pod = deployment.spec?.template?.spec
    const appImage = pod?.containers?.[0]?.image
    const initContainer = pod?.initContainers?.find((container) => container.name === 'await-options-schema')
    const dsn = initContainer?.env?.find((env) => env.name === 'DB_DSN')

    expect(initContainer?.image, `${component} gate image`).toBe(appImage)
    expect(initContainer?.command).toEqual(['python', '/schema-gate/await-options-schema.py'])
    expect(dsn?.valueFrom?.secretKeyRef).toEqual({ name: 'torghut-db-app', key: 'uri' })
    expect(initContainer?.volumeMounts).toContainEqual({
      name: 'options-schema-gate',
      mountPath: '/schema-gate',
      readOnly: true,
    })
    expect(pod?.volumes).toContainEqual({
      name: 'options-schema-gate',
      configMap: { name: 'torghut-options-schema-gate' },
    })
  }
})
