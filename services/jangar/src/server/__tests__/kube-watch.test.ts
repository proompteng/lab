import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const watchMock = vi.hoisted(() => vi.fn())
const specUriPathMock = vi.hoisted(() =>
  vi.fn(async () => '/apis/agents.proompteng.ai/v1alpha1/namespaces/agents/agentruns'),
)

vi.mock('@kubernetes/client-node', () => ({
  Watch: class MockWatch {
    watch = watchMock
  },
}))

const recordWatchEventMock = vi.hoisted(() => vi.fn())
const recordWatchErrorMock = vi.hoisted(() => vi.fn())
const recordWatchRestartMock = vi.hoisted(() => vi.fn())
const recordReliabilityEventMock = vi.hoisted(() => vi.fn())
const recordReliabilityErrorMock = vi.hoisted(() => vi.fn())
const recordReliabilityRestartMock = vi.hoisted(() => vi.fn())

vi.mock('~/server/metrics', () => ({
  recordKubeWatchEvent: (...args: unknown[]) => recordWatchEventMock(...args),
  recordKubeWatchError: (...args: unknown[]) => recordWatchErrorMock(...args),
  recordKubeWatchRestart: (...args: unknown[]) => recordWatchRestartMock(...args),
}))

vi.mock('~/server/control-plane-watch-reliability', () => ({
  recordWatchReliabilityEvent: (...args: unknown[]) => recordReliabilityEventMock(...args),
  recordWatchReliabilityError: (...args: unknown[]) => recordReliabilityErrorMock(...args),
  recordWatchReliabilityRestart: (...args: unknown[]) => recordReliabilityRestartMock(...args),
}))

vi.mock('~/server/primitives-kube', () => ({
  getNativeKubeClients: () => ({
    kubeConfig: {},
    objects: {
      specUriPath: specUriPathMock,
    },
  }),
  buildKubernetesResourceCollectionPath: () => '/apis/agents.proompteng.ai/v1alpha1/namespaces/agents/agentruns',
  buildBunKubernetesFetchInit: vi.fn(async () => ({ method: 'GET', headers: new Headers() })),
  resolveKubernetesResourceTarget: () => ({
    apiVersion: 'agents.proompteng.ai/v1alpha1',
    kind: 'AgentRun',
    namespaceScoped: true,
  }),
  shouldUseBunKubernetesTransport: () => false,
}))

import { resetKubectlWatchCompatibilityCacheForTests, startResourceWatch } from '~/server/kube-watch'

type WatchCall = {
  path: string
  query: Record<string, unknown>
  callback: (type: string, object: unknown) => void
  done: (error: Error | null) => void
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('kube-watch', () => {
  let watchHandle: ReturnType<typeof startResourceWatch> | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    watchMock.mockReset()
    specUriPathMock.mockClear()
    recordWatchEventMock.mockReset()
    recordWatchErrorMock.mockReset()
    recordWatchRestartMock.mockReset()
    recordReliabilityEventMock.mockReset()
    recordReliabilityErrorMock.mockReset()
    recordReliabilityRestartMock.mockReset()
    watchMock.mockImplementation(async () => ({ abort: vi.fn() }))
    resetKubectlWatchCompatibilityCacheForTests()
  })

  afterEach(() => {
    if (watchHandle) {
      watchHandle.stop()
      watchHandle = null
    }
    vi.useRealTimers()
  })

  const getWatchCall = (index = 0): WatchCall => {
    const call = watchMock.mock.calls[index]
    return {
      path: call?.[0] as string,
      query: (call?.[1] as Record<string, unknown>) ?? {},
      callback: call?.[2] as (type: string, object: unknown) => void,
      done: call?.[3] as (error: Error | null) => void,
    }
  }

  it('records watch events and forwards payloads to the event handler', async () => {
    const onEvent = vi.fn()
    watchHandle = startResourceWatch({
      resource: 'agentruns',
      namespace: 'agents',
      onEvent,
    })

    await flush()
    const watchCall = getWatchCall()
    watchCall.callback('ADDED', { kind: 'AgentRun' })
    watchCall.callback('BOOKMARK', { kind: 'AgentRun' })

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith({ type: 'ADDED', object: { kind: 'AgentRun' } })
    expect(recordWatchEventMock).toHaveBeenCalledWith({
      resource: 'agentruns',
      namespace: 'agents',
      type: 'ADDED',
    })
    expect(recordReliabilityEventMock).toHaveBeenCalledWith({
      resource: 'agentruns',
      namespace: 'agents',
    })
  })

  it('restarts watch and records restart metrics when the native watch errors', async () => {
    watchHandle = startResourceWatch({
      resource: 'agentruns',
      namespace: 'agents',
      onEvent: vi.fn(),
      restartDelayMs: 2000,
    })

    await flush()
    const first = getWatchCall()
    first.done(new Error('boom'))

    expect(recordWatchErrorMock).toHaveBeenCalledWith({
      resource: 'agentruns',
      namespace: 'agents',
      reason: 'watch_error',
    })
    expect(recordWatchRestartMock).toHaveBeenCalledWith({
      resource: 'agentruns',
      namespace: 'agents',
      reason: 'watch_error',
    })

    vi.advanceTimersByTime(2000)
    await flush()
    expect(watchMock).toHaveBeenCalledTimes(2)
  })

  it('invokes onRestart with the restart reason when the watch errors', async () => {
    const onRestart = vi.fn()
    watchHandle = startResourceWatch({
      resource: 'agentruns',
      namespace: 'agents',
      onEvent: vi.fn(),
      onRestart,
      restartDelayMs: 2000,
    })

    await flush()
    getWatchCall().done(new Error('boom'))

    expect(onRestart).toHaveBeenCalledWith('watch_error')
  })

  it('starts the watch with the requested resource version', async () => {
    watchHandle = startResourceWatch({
      resource: 'agentruns',
      namespace: 'agents',
      resourceVersion: '12345',
      onEvent: vi.fn(),
    })

    await flush()
    expect(getWatchCall().query).toMatchObject({
      resourceVersion: '12345',
    })
  })

  it('restarts from the latest observed resource version after a watch error', async () => {
    watchHandle = startResourceWatch({
      resource: 'agentruns',
      namespace: 'agents',
      resourceVersion: '12345',
      onEvent: vi.fn(),
      restartDelayMs: 2000,
    })

    await flush()
    expect(getWatchCall().query.resourceVersion).toBe('12345')

    const first = getWatchCall()
    first.callback('MODIFIED', { metadata: { resourceVersion: '12399' } })
    first.done(new Error('boom'))

    vi.advanceTimersByTime(2000)
    await flush()

    expect(watchMock).toHaveBeenCalledTimes(2)
    expect(getWatchCall(1).query.resourceVersion).toBe('12399')
  })

  it('drops the carried resource version when a restarted watch dies before any event', async () => {
    watchHandle = startResourceWatch({
      resource: 'agentruns',
      namespace: 'agents',
      resourceVersion: '12345',
      onEvent: vi.fn(),
      restartDelayMs: 2000,
    })

    await flush()
    expect(getWatchCall().query.resourceVersion).toBe('12345')

    getWatchCall().done(new Error('boom'))
    vi.advanceTimersByTime(2000)
    await flush()

    expect(getWatchCall(1).query.resourceVersion).toBeUndefined()
  })
})
