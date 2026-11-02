import { describe, expect, it } from 'vitest'

import type { ControlPlanePrimitiveRegistryEntry } from './primitive-registry.generated'
import { materializePrimitiveManifest } from './manifest'

const primitive = {
  kind: 'Example',
  group: 'examples.proompteng.ai',
  version: 'v1alpha1',
  plural: 'examples',
  scope: 'Namespaced',
  apiVersion: 'examples.proompteng.ai/v1alpha1',
  sourceFile: 'example.yaml',
  display: {
    label: 'Example',
    description: 'Example',
    category: 'Examples',
    pathSegment: 'example',
  },
  schema: {
    properties: {
      spec: {
        type: 'object',
        properties: {
          config: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
          enabled: { type: 'boolean' },
          retries: { type: 'integer' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} satisfies ControlPlanePrimitiveRegistryEntry

describe('manifest materialization', () => {
  it('coerces schema form values into a clean manifest', () => {
    const manifest = materializePrimitiveManifest(primitive, {
      metadata: { name: 'demo', namespace: 'agents' },
      spec: {
        config: '{"level":"safe"}',
        enabled: true,
        retries: '2',
        tags: ['one', '', 'two'],
      },
    })

    expect(manifest).toEqual({
      apiVersion: 'examples.proompteng.ai/v1alpha1',
      kind: 'Example',
      metadata: { name: 'demo', namespace: 'agents' },
      spec: {
        config: { level: 'safe' },
        enabled: true,
        retries: 2,
        tags: ['one', 'two'],
      },
    })
  })
})
