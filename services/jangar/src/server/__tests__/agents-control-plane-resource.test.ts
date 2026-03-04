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

import { getPrimitiveResource } from '~/routes/api/agents/control-plane/resource'

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

describe('agents control-plane resource route', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    delete process.env.JANGAR_CONTROL_PLANE_CACHE_ENABLED
    delete process.env.JANGAR_CONTROL_PLANE_CACHE_STALE_SECONDS
    delete process.env.JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE
  })

  it('returns cached resource with freshness metadata when cache is fresh', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-20T00:00:10Z'))

    process.env.JANGAR_CONTROL_PLANE_CACHE_ENABLED = '1'
    process.env.JANGAR_CONTROL_PLANE_CACHE_STALE_SECONDS = '60'
    process.env.JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE = '1'

    const cachedStore = {
      ready: Promise.resolve(),
      close: vi.fn(async () => undefined),
      getDbNow: vi.fn(async () => new Date()),
      upsertResource: vi.fn(),
      markDeleted: vi.fn(),
      markNotSeenSince: vi.fn(),
      getResource: vi.fn(async () => cacheResource('agent-a', '2026-01-20T00:00:08Z')),
      listResources: vi.fn(),
    }
    cacheStoreMocks.createControlPlaneCacheStore.mockReturnValue(cachedStore)
    const kube = {
      get: vi.fn(async () => ({ status: 'miss', metadata: { name: 'agent-a' } })),
    } as unknown as ReturnType<(typeof import('~/server/primitives-kube'))['createKubernetesClient']>
    kubeClientMocks.createKubernetesClient.mockReturnValue(kube)

    const response = await getPrimitiveResource(
      new Request('http://localhost/api/agents/control-plane/resource?kind=Agent&name=agent-a&namespace=agents'),
      { kubeClient: kube as never },
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.ok).toBe(true)
    expect(payload.kind).toBe('Agent')
    expect(payload.cache).toMatchObject({
      source: 'control-plane-cache',
      stale: false,
      fresh: true,
      max_age_seconds: 60,
    })
    expect(payload.resource).toMatchObject({ apiVersion: 'agents.proompteng.ai/v1alpha1', kind: 'Agent' })
  })

  it('returns stale cached resource with metadata when stale reads are allowed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-20T00:00:10Z'))

    process.env.JANGAR_CONTROL_PLANE_CACHE_ENABLED = '1'
    process.env.JANGAR_CONTROL_PLANE_CACHE_STALE_SECONDS = '5'
    process.env.JANGAR_CONTROL_PLANE_CACHE_ALLOW_STALE = '1'

    const cachedStore = {
      ready: Promise.resolve(),
      close: vi.fn(async () => undefined),
      getDbNow: vi.fn(async () => new Date()),
      upsertResource: vi.fn(),
      markDeleted: vi.fn(),
      markNotSeenSince: vi.fn(),
      getResource: vi.fn(async () => cacheResource('agent-a', '2026-01-20T00:00:00Z')),
      listResources: vi.fn(),
    }
    cacheStoreMocks.createControlPlaneCacheStore.mockReturnValue(cachedStore)
    const kube = {
      get: vi.fn(async () => ({ status: 'miss', metadata: { name: 'agent-a' } })),
    }
    kubeClientMocks.createKubernetesClient.mockReturnValue(kube as never)

    const response = await getPrimitiveResource(
      new Request('http://localhost/api/agents/control-plane/resource?kind=Agent&name=agent-a&namespace=agents'),
      { kubeClient: kube as never },
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.ok).toBe(true)
    expect(payload.kind).toBe('Agent')
    expect(payload.cache).toMatchObject({
      source: 'control-plane-cache',
      stale: true,
      fresh: false,
      max_age_seconds: 5,
      age_seconds: 10,
    })
    expect(kube.get).not.toHaveBeenCalled()
  })

  it('falls back to Kubernetes when cached resource is stale and stale reads are disabled', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-20T00:02:00Z'))

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
      getResource: vi.fn(async () => cacheResource('agent-a', '2026-01-20T00:01:00Z')),
      listResources: vi.fn(),
    }
    cacheStoreMocks.createControlPlaneCacheStore.mockReturnValue(cachedStore)
    const kube = {
      get: vi.fn(async () => ({
        apiVersion: 'agents.proompteng.ai/v1alpha1',
        kind: 'Agent',
        metadata: { name: 'agent-a' },
        spec: {},
        status: {},
      })),
    } as unknown as ReturnType<(typeof import('~/server/primitives-kube'))['createKubernetesClient']>
    kubeClientMocks.createKubernetesClient.mockReturnValue(kube)

    const response = await getPrimitiveResource(
      new Request('http://localhost/api/agents/control-plane/resource?kind=Agent&name=agent-a&namespace=agents'),
      { kubeClient: kube as never },
    )

    expect(response.status).toBe(200)
    const payload = (await response.json()) as Record<string, unknown>
    expect(payload.ok).toBe(true)
    expect(payload.kind).toBe('Agent')
    expect(payload.resource).toMatchObject({ apiVersion: 'agents.proompteng.ai/v1alpha1' })
    expect(payload).not.toHaveProperty('cache')
    expect(kube.get).toHaveBeenCalledTimes(1)
  })
})
