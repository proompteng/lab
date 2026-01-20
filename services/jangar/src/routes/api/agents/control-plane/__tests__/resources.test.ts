import { describe, expect, it, vi } from 'vitest'

import { listPrimitiveResources } from '~/routes/api/agents/control-plane/resources'

const createKubeMock = (items: Array<Record<string, unknown>>) => ({
  list: vi.fn(async () => ({ items })),
})

const buildRequest = (query: string) =>
  new Request(`http://localhost/api/agents/control-plane/resources?${query}`, { method: 'GET' })

describe('control-plane resources list', () => {
  it('filters agent runs by runtime type', async () => {
    const kube = createKubeMock([
      {
        kind: 'AgentRun',
        metadata: { name: 'run-1' },
        spec: { runtime: { type: 'job' } },
        status: { phase: 'Succeeded' },
      },
      {
        kind: 'AgentRun',
        metadata: { name: 'run-2' },
        spec: { runtime: { type: 'stream' } },
        status: { phase: 'Succeeded' },
      },
    ])

    const response = await listPrimitiveResources(buildRequest('kind=AgentRun&namespace=agents&runtime=job'), {
      kubeClient: kube,
    })

    expect(response.status).toBe(200)
    const payload = (await response.json()) as { total: number; items: Array<{ metadata: Record<string, unknown> }> }
    expect(payload.total).toBe(1)
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]?.metadata?.name).toBe('run-1')
  })

  it('filters agent runs by phase', async () => {
    const kube = createKubeMock([
      {
        kind: 'AgentRun',
        metadata: { name: 'run-1' },
        spec: { runtime: { type: 'job' } },
        status: { phase: 'Succeeded' },
      },
      {
        kind: 'AgentRun',
        metadata: { name: 'run-2' },
        spec: { runtime: { type: 'job' } },
        status: { phase: 'Failed' },
      },
    ])

    const response = await listPrimitiveResources(buildRequest('kind=AgentRun&namespace=agents&phase=Succeeded'), {
      kubeClient: kube,
    })

    expect(response.status).toBe(200)
    const payload = (await response.json()) as { total: number; items: Array<{ metadata: Record<string, unknown> }> }
    expect(payload.total).toBe(1)
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]?.metadata?.name).toBe('run-1')
  })
})
