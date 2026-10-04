import { describe, expect, it } from 'vitest'

import {
  createPrimitiveResourceForUi,
  getPrimitiveResourceForUi,
  listPrimitiveResourcesForUi,
} from './control-plane-ui-api'
import { RESOURCE_MAP, type KubernetesClient } from './kube-types'

const fakeKube = (overrides: Partial<KubernetesClient>) =>
  ({
    list: async () => ({ items: [] }),
    get: async () => null,
    apply: async (resource: unknown) => resource,
    ...overrides,
  }) as KubernetesClient

describe('control-plane UI typed-resource API', () => {
  it('keeps list namespace semantics', async () => {
    const calls: Array<{ resource: string; namespace: string }> = []
    const kube = fakeKube({
      list: async (resource, namespace) => {
        calls.push({ resource, namespace })
        return { items: [] }
      },
    })

    const response = await listPrimitiveResourcesForUi(
      'agent',
      new Request('http://agents.local/api/primitives/agent/resources?namespace=custom'),
      { kubeClient: kube },
    )

    expect(response.status).toBe(200)
    expect(calls).toEqual([{ resource: RESOURCE_MAP.Agent, namespace: 'custom' }])
  })

  it('keeps get namespace and name semantics', async () => {
    const calls: Array<{ resource: string; namespace: string; name: string }> = []
    const kube = fakeKube({
      get: async (resource, name, namespace) => {
        calls.push({ resource, namespace, name })
        return { kind: 'Agent', metadata: { name, namespace } }
      },
    })

    const response = await getPrimitiveResourceForUi(
      'agent',
      new Request('http://agents.local/api/primitives/agent/resource?namespace=custom&name=demo'),
      { kubeClient: kube },
    )

    expect(response.status).toBe(200)
    expect(calls).toEqual([{ resource: RESOURCE_MAP.Agent, namespace: 'custom', name: 'demo' }])
  })

  it('removes AgentRun parameters.prompt when an ImplementationSpec is referenced', async () => {
    const applied: unknown[] = []
    const kube = fakeKube({
      apply: async (resource) => {
        applied.push(resource)
        return resource
      },
    })

    const response = await createPrimitiveResourceForUi(
      'agent-run',
      new Request('http://agents.local/api/primitives/agent-run/resources', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'ui-test-key',
        },
        body: JSON.stringify({
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: 'AgentRun',
          metadata: { name: 'demo', namespace: 'agents' },
          spec: {
            agentRef: { name: 'demo-agent' },
            implementationSpecRef: { name: 'demo-spec' },
            parameters: { prompt: 'must not be submitted', head: 'codex/demo' },
          },
        }),
      }),
      { kubeClient: kube },
    )

    expect(response.status).toBe(201)
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({
      kind: 'AgentRun',
      spec: {
        implementationSpecRef: { name: 'demo-spec' },
        parameters: { head: 'codex/demo' },
      },
    })
    expect(JSON.stringify(applied[0])).not.toContain('must not be submitted')
  })
})
