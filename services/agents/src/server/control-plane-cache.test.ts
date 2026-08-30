import { afterEach, describe, expect, it, vi } from 'vitest'

const kubeMocks = vi.hoisted(() => ({
  createKubernetesClient: vi.fn(),
}))

vi.mock('~/server/kube-types', async () => {
  const actual = await vi.importActual<typeof import('~/server/kube-types')>('~/server/kube-types')
  return {
    ...actual,
    createKubernetesClient: kubeMocks.createKubernetesClient,
  }
})

import { RESOURCE_MAP } from './kube-types'
import { __test__ } from './control-plane-cache'
import type { ControlPlaneCacheStore, UpsertControlPlaneCacheResourceInput } from './control-plane-cache-store'

const buildStore = (overrides: Partial<ControlPlaneCacheStore> = {}): ControlPlaneCacheStore =>
  ({
    ready: Promise.resolve(),
    close: vi.fn(async () => undefined),
    getDbNow: vi.fn(async () => '2026-05-20T00:00:00.000Z'),
    upsertResource: vi.fn(async () => undefined),
    markDeleted: vi.fn(async () => undefined),
    markNotSeenSince: vi.fn(async () => undefined),
    getResource: vi.fn(async () => null),
    listResources: vi.fn(async () => ({ items: [], total: 0 })),
    ...overrides,
  }) as ControlPlaneCacheStore

const buildUpsert = (name: string, resourceVersion: string): UpsertControlPlaneCacheResourceInput => ({
  key: { cluster: 'default', kind: 'AgentRun', namespace: 'agents', name },
  uid: `uid-${name}`,
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  resourceVersion,
  generation: 1,
  labels: {},
  annotations: {},
  resource: {
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'AgentRun',
    metadata: { name, namespace: 'agents', resourceVersion },
    spec: {},
    status: {},
  },
  fingerprint: `fingerprint-${resourceVersion}`,
  resourceCreatedAt: '2026-05-20T00:00:00.000Z',
  resourceUpdatedAt: '2026-05-20T00:00:00.000Z',
  statusPhase: null,
  specRuntimeType: null,
  specAgentRefName: null,
  specImplementationSpecRefName: null,
  specSourceProvider: null,
  specSourceExternalId: null,
  specSummary: null,
  specLabels: [],
})

describe('control plane cache', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('coalesces pending cache writes and keeps only one db write in flight', async () => {
    let unblockFirstWrite: () => void = () => {
      throw new Error('first write was not blocked')
    }
    let firstWrite = true
    const firstWriteBlocked = new Promise<void>((resolve) => {
      unblockFirstWrite = resolve
    })
    const upsertResource = vi.fn(async (_input: UpsertControlPlaneCacheResourceInput) => {
      if (!firstWrite) return
      firstWrite = false
      await firstWriteBlocked
    })
    const store = buildStore({ upsertResource })
    const writer = __test__.createControlPlaneCacheWriter({
      store,
      logPrefix: '[test][control-plane-cache]',
      maxPendingWrites: 100,
      retryDelayMs: 1,
    })

    writer.enqueueUpsert(buildUpsert('run-a', '1'))
    await vi.waitFor(() => expect(upsertResource).toHaveBeenCalledTimes(1))

    writer.enqueueUpsert(buildUpsert('run-b', '2'))
    writer.enqueueUpsert(buildUpsert('run-b', '3'))

    expect(writer.pendingSize()).toBe(1)
    unblockFirstWrite()

    await vi.waitFor(() => expect(upsertResource).toHaveBeenCalledTimes(2))
    const secondCall = upsertResource.mock.calls[1]
    expect(secondCall?.[0].resourceVersion).toBe('3')

    writer.stop()
  })

  it('retries transient cache write failures without failing the watch event path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let attempts = 0
    const upsertResource = vi.fn(async (_input: UpsertControlPlaneCacheResourceInput) => {
      attempts += 1
      if (attempts === 1) throw new Error('timeout exceeded when trying to connect')
    })
    const store = buildStore({ upsertResource })
    const writer = __test__.createControlPlaneCacheWriter({
      store,
      logPrefix: '[test][control-plane-cache]',
      maxPendingWrites: 100,
      retryDelayMs: 1,
    })

    writer.enqueueUpsert(buildUpsert('run-a', '1'))

    await vi.waitFor(() => expect(upsertResource).toHaveBeenCalledTimes(2))
    expect(warn).toHaveBeenCalledWith(
      '[test][control-plane-cache] write failed',
      expect.objectContaining({
        kind: 'AgentRun',
        namespace: 'agents',
        name: 'run-a',
      }),
    )

    writer.stop()
  })

  it('returns list resourceVersions for watch startup after the initial cache fill', async () => {
    const list = vi.fn(async (resource: string) => ({
      metadata: { resourceVersion: `rv-${resource}` },
      items: [
        {
          apiVersion: 'agents.proompteng.ai/v1alpha1',
          kind: resource === RESOURCE_MAP.Agent ? 'Agent' : 'AgentRun',
          metadata: {
            name: `resource-${resource.replaceAll('.', '-')}`,
            namespace: 'agents',
            resourceVersion: `item-rv-${resource}`,
          },
          spec: {},
          status: {},
        },
      ],
    }))
    kubeMocks.createKubernetesClient.mockReturnValue({ list })
    const store = buildStore()

    const resourceVersions = await __test__.listOnce('agents', store)

    expect(resourceVersions.get(`agents/${RESOURCE_MAP.Agent}`)).toBe(`rv-${RESOURCE_MAP.Agent}`)
    expect(resourceVersions.get(`agents/${RESOURCE_MAP.AgentRun}`)).toBe(`rv-${RESOURCE_MAP.AgentRun}`)
    expect(store.upsertResource).toHaveBeenCalled()
    expect(store.markNotSeenSince).toHaveBeenCalledWith(
      expect.objectContaining({
        cluster: 'default',
        kind: 'AgentRun',
        namespace: 'agents',
      }),
    )
  })
})
