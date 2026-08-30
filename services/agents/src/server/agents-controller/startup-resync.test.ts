import { setTimeout as delay } from 'node:timers/promises'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const watchMocks = vi.hoisted(() => ({
  startResourceWatch: vi.fn(() => ({ stop: vi.fn() })),
}))

vi.mock('../kube-watch', () => ({
  startResourceWatch: watchMocks.startResourceWatch,
}))

import type { WatchOptions } from '../kube-watch'
import { RESOURCE_MAP } from '../kube-types'
import { __test, stopAgentsController } from './index'

const defaultConcurrency = {
  perNamespace: 10,
  perAgent: 5,
  cluster: 100,
  repoConcurrency: { enabled: false, defaultLimit: 0, overrides: new Map<string, number>() },
}

const buildKube = (overrides: Record<string, unknown> = {}) => ({
  apply: vi.fn(async (resource: Record<string, unknown>) => resource),
  applyStatus: vi.fn(async (resource: Record<string, unknown>) => resource),
  delete: vi.fn(async () => ({})),
  patch: vi.fn(async () => ({})),
  get: vi.fn(async () => null),
  list: vi.fn(async () => ({ items: [] })),
  ...overrides,
})

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('agents controller startup resync', () => {
  beforeEach(() => {
    stopAgentsController()
    watchMocks.startResourceWatch.mockClear()
  })

  afterEach(() => {
    stopAgentsController()
  })

  it('does not block namespace watch startup on the initial AgentRun resync', async () => {
    let releaseManualResync!: () => void
    const manualResyncList = new Promise<{ items: [] }>((resolve) => {
      releaseManualResync = () => resolve({ items: [] })
    })
    let agentRunListCalls = 0
    const kube = buildKube({
      list: vi.fn(async (resource: string) => {
        if (resource === RESOURCE_MAP.AgentRun) {
          agentRunListCalls += 1
          return manualResyncList
        }
        return { items: [] }
      }),
    })
    const handles: Array<{ stop: () => void }> = []
    const startup = __test.startNamespaceWatches(
      kube as never,
      'agents',
      { namespaces: new Map() } as never,
      defaultConcurrency,
      handles,
      { agentRunResourceVersion: '42' },
    )

    try {
      const result = await Promise.race([startup.then(() => 'started'), delay(25).then(() => 'blocked')])

      expect(result).toBe('started')
      expect(agentRunListCalls).toBe(1)
      expect(watchMocks.startResourceWatch).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'agents',
          resource: RESOURCE_MAP.AgentRun,
          resourceVersion: '42',
        }),
      )
    } finally {
      releaseManualResync()
      await startup
      __test.stopWatchHandles(handles)
    }
  })

  it('does not resync AgentRuns for normal watch stream closures', async () => {
    const list = vi.fn(async () => ({ items: [] }))
    const kube = buildKube({ list })
    const handles: Array<{ stop: () => void }> = []

    await __test.startNamespaceWatches(
      kube as never,
      'agents',
      { namespaces: new Map() } as never,
      defaultConcurrency,
      handles,
      { agentRunResourceVersion: '42' },
    )
    await flush()

    list.mockClear()
    const watchCalls = watchMocks.startResourceWatch.mock.calls as unknown as Array<[WatchOptions]>
    const agentRunWatch = watchCalls.find(([options]) => options.resource === RESOURCE_MAP.AgentRun)?.[0]
    expect(agentRunWatch).toBeDefined()

    agentRunWatch?.onRestart?.('closed')
    await flush()
    expect(list).not.toHaveBeenCalled()

    agentRunWatch?.onRestart?.('watch_error')
    await flush()
    expect(list).toHaveBeenCalledWith(RESOURCE_MAP.AgentRun, 'agents')

    __test.stopWatchHandles(handles)
  })

  it('does not trigger full reconcile for dependency heartbeat-only events', () => {
    const existing = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'Memory',
      metadata: {
        name: 'agents-primitives',
        namespace: 'agents',
        generation: 2,
        resourceVersion: '100',
      },
      spec: {
        type: 'postgres',
        connection: { secretRef: { name: 'memory-secret' } },
      },
      status: {
        observedGeneration: 2,
        updatedAt: '2026-01-20T00:00:00Z',
        lastCheckedAt: '2026-01-20T00:00:00Z',
        conditions: [{ type: 'Ready', status: 'True', reason: 'SecretResolved', message: '' }],
      },
    }
    const resources = new Map([[existing.metadata.name, existing]])

    expect(
      __test.shouldDependencyEventTriggerFullReconcile(resources, 'MODIFIED', {
        ...existing,
        metadata: { ...existing.metadata, resourceVersion: '101' },
        status: {
          ...existing.status,
          updatedAt: '2026-01-20T00:01:00Z',
          lastCheckedAt: '2026-01-20T00:01:00Z',
        },
      }),
    ).toBe(false)

    expect(
      __test.shouldDependencyEventTriggerFullReconcile(resources, 'MODIFIED', {
        ...existing,
        metadata: { ...existing.metadata, resourceVersion: '102' },
        spec: {
          ...existing.spec,
          default: true,
        },
      }),
    ).toBe(true)

    expect(
      __test.shouldDependencyEventTriggerFullReconcile(resources, 'MODIFIED', {
        ...existing,
        metadata: { ...existing.metadata, resourceVersion: '103' },
        status: {
          ...existing.status,
          conditions: [{ type: 'Ready', status: 'False', reason: 'SecretNotFound', message: 'secret missing' }],
        },
      }),
    ).toBe(true)

    expect(__test.shouldDependencyEventTriggerFullReconcile(resources, 'DELETED', existing)).toBe(true)
  })

  it('does not apply primitive status when only heartbeat timestamps change', async () => {
    const kube = buildKube()
    const readyCondition = { type: 'Ready', status: 'True', reason: 'Reconciled', message: '' }
    const stablePrimitiveConditions = [
      readyCondition,
      { type: 'Progressing', status: 'False', reason: 'Progressing', message: '' },
      { type: 'Degraded', status: 'False', reason: 'Degraded', message: '' },
    ]

    await __test.setStatus(
      kube as never,
      {
        apiVersion: 'agents.proompteng.ai/v1alpha1',
        kind: 'Memory',
        metadata: { name: 'agents-primitives', namespace: 'agents', generation: 2 },
        status: {
          observedGeneration: 2,
          updatedAt: '2026-01-20T00:00:00Z',
          lastCheckedAt: '2026-01-20T00:00:00Z',
          conditions: stablePrimitiveConditions,
        },
      },
      {
        observedGeneration: 2,
        lastCheckedAt: '2026-01-20T00:01:00Z',
        conditions: [readyCondition],
      },
    )

    await __test.setStatus(
      kube as never,
      {
        apiVersion: 'agents.proompteng.ai/v1alpha1',
        kind: 'VersionControlProvider',
        metadata: { name: 'github', namespace: 'agents', generation: 2 },
        status: {
          observedGeneration: 2,
          updatedAt: '2026-01-20T00:00:00Z',
          lastValidatedAt: '2026-01-20T00:00:00Z',
          conditions: stablePrimitiveConditions,
        },
      },
      {
        observedGeneration: 2,
        lastValidatedAt: '2026-01-20T00:01:00Z',
        conditions: [readyCondition],
      },
    )

    expect(kube.applyStatus).not.toHaveBeenCalled()
  })
})
