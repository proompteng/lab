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

import { listPrimitiveResources } from '~/routes/api/agents/control-plane/resources'

const cacheResource = (name: string, lastSeenAt: string) => ({
  resource: {
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'Agent',
    metadata: { name },
    spec: {},
    status: {},
  },
  lastSeenAt,
  updatedAt: lastSeenAt,
  resourceUpdatedAt: lastSeenAt,
})

describe('agents control-plane resources route', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    delete process.env.JANGAR_CONTROL_PLANE_CACHE_ENABLED
    delete process.env.JANGAR_CONTROL_PLANE_CACHE_STALE_SECONDS
    delete process.env.JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE
  })

  it('returns cached list with freshness metadata when cache is fresh', async () => {
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
      listResources: vi.fn(async () => ({
        total: 2,
        items: [cacheResource('agent-a', '2026-01-20T00:00:20Z'), cacheResource('agent-b', '2026-01-20T00:00:30Z')],
      })),
    }
    cacheStoreMocks.createControlPlaneCacheStore.mockReturnValue(cachedStore)
    const kube = {
      list: vi.fn(async () => ({ items: [] })),
    } as unknown as ReturnType<(typeof import('~/server/primitives-kube'))['createKubernetesClient']>
    kubeClientMocks.createKubernetesClient.mockReturnValue(kube)

    const response = await listPrimitiveResources(
      new Request('http://localhost/api/agents/control-plane/resources?kind=Agent&namespace=agents'),
      { kubeClient: kube },
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.ok).toBe(true)
    expect(payload.kind).toBe('Agent')
    expect(payload.total).toBe(2)
    expect(payload.cache).toMatchObject({ source: 'control-plane-cache', stale: false, stale_count: 0 })
    expect(Array.isArray(payload.items)).toBe(true)
    expect(kube.list).not.toHaveBeenCalled()
  })

  it('falls back to Kubernetes list when cache has stale rows and stale reads are disabled', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-20T00:03:00Z'))

    process.env.JANGAR_CONTROL_PLANE_CACHE_ENABLED = 'on'
    process.env.JANGAR_CONTROL_PLANE_CACHE_STALE_SECONDS = '60'
    process.env.JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE = 'false'

    const cachedStore = {
      ready: Promise.resolve(),
      close: vi.fn(async () => undefined),
      getDbNow: vi.fn(async () => new Date()),
      upsertResource: vi.fn(),
      markDeleted: vi.fn(),
      markNotSeenSince: vi.fn(),
      getResource: vi.fn(),
      listResources: vi.fn(async () => ({
        total: 1,
        items: [cacheResource('agent-a', '2026-01-20T00:01:00Z')],
      })),
    }
    cacheStoreMocks.createControlPlaneCacheStore.mockReturnValue(cachedStore)
    const kube = {
      list: vi.fn(async () => ({
        items: [{ kind: 'Agent', metadata: { name: 'agent-live' }, spec: {}, status: {} }],
      })),
    } as unknown as ReturnType<(typeof import('~/server/primitives-kube'))['createKubernetesClient']>
    kubeClientMocks.createKubernetesClient.mockReturnValue(kube)

    const response = await listPrimitiveResources(
      new Request('http://localhost/api/agents/control-plane/resources?kind=Agent&namespace=agents'),
      { kubeClient: kube },
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.ok).toBe(true)
    expect(payload.cache).toBeUndefined()
    expect(payload.total).toBe(1)
    expect(Array.isArray(payload.items)).toBe(true)
    expect((payload.items as Array<{ metadata?: Record<string, unknown> }>)[0]?.metadata?.name).toBe('agent-live')
    expect(kube.list).toHaveBeenCalledTimes(1)
  })
})
