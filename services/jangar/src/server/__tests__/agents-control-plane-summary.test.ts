import { afterEach, describe, expect, it, vi } from 'vitest'

const cacheStoreMocks = vi.hoisted(() => ({
  createControlPlaneCacheStore: vi.fn(),
}))

const kubeClientMocks = vi.hoisted(() => ({
  createKubernetesClient: vi.fn(),
}))

vi.mock('~/server/control-plane-cache-store', () => cacheStoreMocks)
vi.mock('~/server/primitives-kube', async () => {
  const actual = await vi.importActual<typeof import('~/server/primitives-kube')>('~/server/primitives-kube')
  return {
    ...actual,
    createKubernetesClient: kubeClientMocks.createKubernetesClient,
  }
})

import { getControlPlaneSummary } from '~/routes/api/agents/control-plane/summary'
import { RESOURCE_MAP } from '~/server/primitives-kube'

const buildList = (items: Record<string, unknown>[] = []) => ({ items })

const cacheResource = (name: string, kind: string, status: Record<string, unknown> | null, lastSeenAt: string) => ({
  resource: {
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind,
    metadata: { name },
    spec: {},
    status: status ?? {},
  },
  lastSeenAt,
  updatedAt: lastSeenAt,
  resourceUpdatedAt: lastSeenAt,
})

const buildLiveResponse = (items: Record<string, unknown>[]) => ({ items })

describe('control plane summary route', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    delete process.env.JANGAR_CONTROL_PLANE_CACHE_ENABLED
    delete process.env.JANGAR_CONTROL_PLANE_CACHE_STALE_SECONDS
    delete process.env.JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE
  })

  it('aggregates totals and run phases without cache when cache is disabled', async () => {
    const lists: Record<string, Record<string, unknown>> = {
      [RESOURCE_MAP.Agent]: buildList([{}, {}]),
      [RESOURCE_MAP.AgentRun]: buildList([
        { status: { phase: 'Pending' } },
        { status: { phase: 'Running' } },
        { status: { phase: 'Running' } },
        { status: {} },
      ]),
      [RESOURCE_MAP.Orchestration]: buildList([]),
      [RESOURCE_MAP.OrchestrationRun]: buildList([
        { status: { phase: 'Succeeded' } },
        { status: { phase: 'Failed' } },
        { status: { phase: 'Cancelled' } },
      ]),
      [RESOURCE_MAP.ImplementationSpec]: buildList([{}]),
      [RESOURCE_MAP.ImplementationSource]: buildList([{}, {}, {}]),
      [RESOURCE_MAP.Memory]: buildList([]),
      [RESOURCE_MAP.Tool]: buildList([{}]),
      [RESOURCE_MAP.Signal]: buildList([{}, {}]),
      [RESOURCE_MAP.Schedule]: buildList([]),
      [RESOURCE_MAP.Swarm]: buildList([{}]),
      [RESOURCE_MAP.Artifact]: buildList([{}]),
      [RESOURCE_MAP.Workspace]: buildList([{}, {}]),
    }

    const kube = {
      list: vi.fn(async (resource: string) => lists[resource] ?? buildList()),
    }
    kubeClientMocks.createKubernetesClient.mockReturnValue(kube)

    const response = await getControlPlaneSummary(
      new Request('http://localhost/api/agents/control-plane/summary?namespace=agents'),
      { kubeClient: kube },
    )

    expect(kube.list).toHaveBeenCalled()
    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.ok).toBe(true)
    expect(payload.namespace).toBe('agents')

    const resources = payload.resources as Record<string, Record<string, unknown>>
    expect(resources.Agent.total).toBe(2)
    expect(resources.AgentRun.total).toBe(4)
    expect(resources.Orchestration.total).toBe(0)
    expect(resources.OrchestrationRun.total).toBe(3)
    expect(resources.Swarm.total).toBe(1)

    const agentRunPhases = resources.AgentRun.phases as Record<string, number>
    expect(agentRunPhases.Pending).toBe(1)
    expect(agentRunPhases.Running).toBe(2)
    expect(agentRunPhases.Unknown).toBe(1)

    const orchestrationRunPhases = resources.OrchestrationRun.phases as Record<string, number>
    expect(orchestrationRunPhases.Succeeded).toBe(1)
    expect(orchestrationRunPhases.Failed).toBe(1)
    expect(orchestrationRunPhases.Cancelled).toBe(1)
    expect(resources.Agent.cache).toBeUndefined()
  })

  it('uses cache for supported summary kinds and returns freshness metadata', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-20T00:00:40Z'))

    process.env.JANGAR_CONTROL_PLANE_CACHE_ENABLED = 'on'
    process.env.JANGAR_CONTROL_PLANE_CACHE_STALE_SECONDS = '60'
    process.env.JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE = '1'

    const cachedStore = {
      ready: Promise.resolve(),
      close: vi.fn(async () => undefined),
      getDbNow: vi.fn(async () => new Date()),
      upsertResource: vi.fn(),
      markDeleted: vi.fn(),
      markNotSeenSince: vi.fn(),
      getResource: vi.fn(),
      listResources: vi.fn(async ({ kind }: { kind: string }) => {
        if (kind === 'Agent') {
          return {
            total: 2,
            items: [
              cacheResource('agent-a', 'Agent', {}, '2026-01-20T00:00:20Z'),
              cacheResource('agent-b', 'Agent', {}, '2026-01-20T00:00:30Z'),
            ],
          }
        }

        if (kind === 'AgentRun') {
          return {
            total: 3,
            items: [
              cacheResource('run-a', 'AgentRun', { phase: 'Running' }, '2026-01-20T00:00:30Z'),
              cacheResource('run-b', 'AgentRun', { phase: 'Failed' }, '2026-01-20T00:00:15Z'),
              cacheResource('run-c', 'AgentRun', { phase: 'Succeeded' }, '2026-01-20T00:00:25Z'),
            ],
          }
        }

        if (kind === 'ImplementationSpec' || kind === 'ImplementationSource') {
          return {
            total: 0,
            items: [],
          }
        }

        return { total: 0, items: [] }
      }),
    }
    cacheStoreMocks.createControlPlaneCacheStore.mockReturnValue(cachedStore)

    const kube = {
      list: vi.fn(async () => ({ items: [] })),
    }
    kubeClientMocks.createKubernetesClient.mockReturnValue(kube)

    const response = await getControlPlaneSummary(
      new Request('http://localhost/api/agents/control-plane/summary?namespace=agents'),
      { kubeClient: kube },
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.ok).toBe(true)

    const resources = payload.resources as Record<string, Record<string, unknown>>
    expect(resources.Agent.total).toBe(2)
    expect(resources.Agent.cache).toMatchObject({ source: 'control-plane-cache', stale: false, stale_count: 0 })
    expect(resources.AgentRun.phases).toMatchObject({ Pending: 0, Running: 1, Succeeded: 1, Failed: 1 })
    expect(resources.OrchestrationRun.total).toBe(0)
    expect(resources.OrchestrationRun.phases).toMatchObject({
      Succeeded: 0,
      Failed: 0,
      Cancelled: 0,
      Pending: 0,
      Running: 0,
      Unknown: 0,
    })
    expect(resources.Tool.cache).toBeUndefined()
    expect(resources.Orchestration.cache).toBeUndefined()
    expect(cachedStore.listResources).toHaveBeenCalledTimes(4)
    expect(kube.list).toHaveBeenCalled()
  })

  it('falls back to Kubernetes when cached summary rows are stale and stale reads are disabled', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-20T00:05:00Z'))

    process.env.JANGAR_CONTROL_PLANE_CACHE_ENABLED = '1'
    process.env.JANGAR_CONTROL_PLANE_CACHE_STALE_SECONDS = '30'
    process.env.JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE = 'false'

    const cachedStore = {
      ready: Promise.resolve(),
      close: vi.fn(async () => undefined),
      getDbNow: vi.fn(async () => new Date()),
      upsertResource: vi.fn(),
      markDeleted: vi.fn(),
      markNotSeenSince: vi.fn(),
      getResource: vi.fn(),
      listResources: vi.fn(async ({ kind }: { kind: string }) => {
        if (kind === 'Agent' || kind === 'AgentRun') {
          return {
            total: 2,
            items: [
              cacheResource(
                `${kind.toLowerCase()}-a`,
                kind,
                kind === 'AgentRun' ? { phase: 'Running' } : {},
                '2026-01-20T00:03:00Z',
              ),
              cacheResource(
                `${kind.toLowerCase()}-b`,
                kind,
                kind === 'AgentRun' ? { phase: 'Pending' } : {},
                '2026-01-20T00:03:10Z',
              ),
            ],
          }
        }

        return { total: 0, items: [] }
      }),
    }
    cacheStoreMocks.createControlPlaneCacheStore.mockReturnValue(cachedStore)

    const kube = {
      list: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.Agent) {
          return buildLiveResponse([{ metadata: { name: 'agent-live-a' }, spec: {}, status: {} }])
        }
        if (resource === RESOURCE_MAP.AgentRun) {
          return buildLiveResponse([{ status: { phase: 'Succeeded' } }, { status: { phase: 'Failed' } }])
        }
        return buildLiveResponse([])
      }),
    }
    kubeClientMocks.createKubernetesClient.mockReturnValue(kube)

    const response = await getControlPlaneSummary(
      new Request('http://localhost/api/agents/control-plane/summary?namespace=agents'),
      { kubeClient: kube },
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    const resources = payload.resources as Record<string, Record<string, unknown>>

    expect(resources.Agent.cache).toBeUndefined()
    expect(resources.Agent.total).toBe(1)
    expect((resources.AgentRun.phases as Record<string, number>).Succeeded).toBe(1)
    expect((resources.AgentRun.phases as Record<string, number>).Failed).toBe(1)
    expect((resources.AgentRun.phases as Record<string, number>).Running).toBe(0)
    expect(resources.AgentRun.total as number).toBe(2)
    expect(kube.list).toHaveBeenCalled()
  })
})
