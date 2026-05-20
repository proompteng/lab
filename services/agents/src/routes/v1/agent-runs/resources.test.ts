import { describe, expect, it, vi } from 'vitest'

import { listAgentRunResources, patchAgentRunResourceAnnotations } from './resources'

const buildKube = () => ({
  list: vi.fn(async () => ({
    items: [{ kind: 'AgentRun', metadata: { name: 'wp-run', namespace: 'agents' }, status: { phase: 'Succeeded' } }],
  })),
  patch: vi.fn(async () => ({
    kind: 'AgentRun',
    metadata: { name: 'wp-run', namespace: 'agents', annotations: { finalized: 'true' } },
  })),
})

const asListDepsKube = (kube: ReturnType<typeof buildKube>) =>
  kube as unknown as NonNullable<Parameters<typeof listAgentRunResources>[1]>['kubeClient']

const asPatchDepsKube = (kube: ReturnType<typeof buildKube>) =>
  kube as unknown as NonNullable<Parameters<typeof patchAgentRunResourceAnnotations>[1]>['kubeClient']

describe('Agents v1 AgentRun resource route', () => {
  it('lists AgentRun resources without exposing the generic control-plane kind selector', async () => {
    const kube = buildKube()
    const response = await listAgentRunResources(
      new Request('http://agents.local/v1/agent-runs/resources?namespace=agents&phase=Succeeded&limit=10&kind=Swarm'),
      { kubeClient: asListDepsKube(kube) },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      kind: 'AgentRun',
      namespace: 'agents',
      items: [{ kind: 'AgentRun', metadata: { name: 'wp-run', namespace: 'agents' } }],
    })
    expect(kube.list).toHaveBeenCalledWith('agentruns.agents.proompteng.ai', 'agents', undefined)
  })

  it('patches AgentRun annotations through the dedicated v1 resource route', async () => {
    const kube = buildKube()
    const response = await patchAgentRunResourceAnnotations(
      new Request('http://agents.local/v1/agent-runs/resources?name=wp-run&namespace=agents&kind=Swarm', {
        body: JSON.stringify({
          annotations: {
            'jangar.proompteng.ai/whitepaper-finalized-phase': 'Succeeded',
          },
        }),
        method: 'PATCH',
      }),
      { kubeClient: asPatchDepsKube(kube) },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      kind: 'AgentRun',
      namespace: 'agents',
      resource: { kind: 'AgentRun', metadata: { name: 'wp-run' } },
    })
    expect(kube.patch).toHaveBeenCalledWith('agentruns.agents.proompteng.ai', 'wp-run', 'agents', {
      metadata: {
        annotations: {
          'jangar.proompteng.ai/whitepaper-finalized-phase': 'Succeeded',
        },
      },
    })
  })
})
