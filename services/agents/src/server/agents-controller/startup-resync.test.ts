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
})
