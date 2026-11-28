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
    upsertResources: vi.fn(async () => undefined),
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
    const upsertResources = vi.fn(async (_inputs: UpsertControlPlaneCacheResourceInput[]) => {
      if (!firstWrite) return
      firstWrite = false
      await firstWriteBlocked
    })
    const store = buildStore({ upsertResources })
    const writer = __test__.createControlPlaneCacheWriter({
      store,
      logPrefix: '[test][control-plane-cache]',
      maxPendingWrites: 100,
      retryDelayMs: 1,
    })

    writer.enqueueUpsert(buildUpsert('run-a', '1'))
    await vi.waitFor(() => expect(upsertResources).toHaveBeenCalledTimes(1))

    writer.enqueueUpsert(buildUpsert('run-b', '2'))
    writer.enqueueUpsert(buildUpsert('run-b', '3'))

    expect(writer.pendingSize()).toBe(1)
    unblockFirstWrite()

    await vi.waitFor(() => expect(upsertResources).toHaveBeenCalledTimes(2))
    const secondCall = upsertResources.mock.calls[1]
    expect(secondCall?.[0][0]?.resourceVersion).toBe('3')

    writer.stop()
  })

  it('drains a 200-run burst in nine writes without losing the latest version or a deletion', async () => {
    const first = Promise.withResolvers<void>()
    const final = Promise.withResolvers<void>()
    const persisted = new Map<string, string | null>()
    const upsertResources = vi.fn(async (batch: UpsertControlPlaneCacheResourceInput[]) => {
      if (persisted.size === 0) await first.promise
      for (const row of batch) persisted.set(row.key.name, row.resourceVersion)
    })
    const markDeleted = vi.fn(async ({ name }: { name: string }) => {
      persisted.set(name, null)
      final.resolve()
    })
    const store = buildStore({ upsertResources, markDeleted })
    const writer = __test__.createControlPlaneCacheWriter({ store, logPrefix: '[test]', maxPendingWrites: 300 })

    try {
      for (let i = 0; i < 200; i++) {
        writer.enqueueUpsert(buildUpsert(`run-${i}`, '1'))
        if (i > 0) writer.enqueueUpsert(buildUpsert(`run-${i}`, '2'))
      }
      writer.enqueueDelete(buildUpsert('run-0', '1').key)
      first.resolve()
      await final.promise

      expect(persisted.size).toBe(200)
      expect(persisted.get('run-0')).toBeNull()
      expect([...persisted.values()].filter((version) => version === '2')).toHaveLength(199)
      expect(upsertResources).toHaveBeenCalledTimes(9)
      expect(markDeleted).toHaveBeenCalledTimes(1)
    } finally {
      writer.stop()
    }
  })

  it('isolates a failed batch and does not replay an obsolete write after a deletion', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const first = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<void>()
    const upsertResources = vi.fn(async (batch: UpsertControlPlaneCacheResourceInput[]) => {
      if (batch[0]?.key.name === 'first') await first.promise
      if (batch.length > 1) await failed.promise
    })
    const store = buildStore({ upsertResources })
    const writer = __test__.createControlPlaneCacheWriter({
      store,
      logPrefix: '[test]',
      maxPendingWrites: 10,
      retryDelayMs: 5,
    })
    try {
      writer.enqueueUpsert(buildUpsert('first', '1'))
      const removed = buildUpsert('removed', '1')
      const live = buildUpsert('live', '2')
      writer.enqueueUpsert(removed)
      writer.enqueueUpsert(live)
      first.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(upsertResources).toHaveBeenLastCalledWith([removed, live])
      writer.enqueueDelete(removed.key)
      failed.reject(new Error('invalid fixture row'))
      await vi.advanceTimersByTimeAsync(5)
      expect(store.markDeleted).toHaveBeenCalledExactlyOnceWith(removed.key)
      expect(upsertResources.mock.calls.map(([batch]) => batch)).toEqual([
        [buildUpsert('first', '1')],
        [removed, live],
        [live],
      ])
    } finally {
      writer.stop()
      vi.useRealTimers()
    }
  })

  it('retries transient cache write failures without failing the watch event path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let attempts = 0
    const upsertResources = vi.fn(async (_inputs: UpsertControlPlaneCacheResourceInput[]) => {
      attempts += 1
      if (attempts === 1) throw new Error('timeout exceeded when trying to connect')
    })
    const store = buildStore({ upsertResources })
    const writer = __test__.createControlPlaneCacheWriter({
      store,
      logPrefix: '[test][control-plane-cache]',
      maxPendingWrites: 100,
      retryDelayMs: 1,
    })

    writer.enqueueUpsert(buildUpsert('run-a', '1'))

    await vi.waitFor(() => expect(upsertResources).toHaveBeenCalledTimes(2))
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
    expect(store.upsertResources).toHaveBeenCalledWith(
      [expect.objectContaining({ key: expect.objectContaining({ kind: 'AgentRun' }) })],
      '2026-05-20T00:00:00.000Z',
    )
    expect(store.markNotSeenSince).toHaveBeenCalledWith(
      expect.objectContaining({
        cluster: 'default',
        kind: 'AgentRun',
        namespace: 'agents',
      }),
    )
  })
})
