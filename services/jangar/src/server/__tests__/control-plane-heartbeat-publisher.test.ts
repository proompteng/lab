import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  __test__,
  publishControlPlaneHeartbeatsOnce,
  startControlPlaneHeartbeatPublisher,
} from '~/server/control-plane-heartbeat-publisher'
import { resolveControlPlaneHeartbeatIntervalSeconds } from '~/server/control-plane-heartbeat-store'

const leaderStatus = {
  enabled: true,
  required: true,
  isLeader: true,
  leaseName: 'jangar-controller-leader',
  leaseNamespace: 'agents',
  identity: 'agents-controllers-0',
  lastTransitionAt: '2026-03-08T12:00:00Z',
  lastAttemptAt: '2026-03-08T12:00:00Z',
  lastSuccessAt: '2026-03-08T12:00:00Z',
  lastError: null,
}

const followerStatus = {
  ...leaderStatus,
  isLeader: false,
}

const healthyController = {
  enabled: true,
  started: true,
  namespaces: ['agents'],
  crdsReady: true,
  missingCrds: [],
  lastCheckedAt: '2026-03-08T12:00:00Z',
}

describe('control-plane heartbeat publisher', () => {
  afterEach(async () => {
    await __test__.resetPublisherState()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('publishes authoritative controller rows from the leader workload', async () => {
    const upsertHeartbeat = vi.fn(async () => undefined)

    const published = await publishControlPlaneHeartbeatsOnce({
      now: () => new Date('2026-03-08T12:00:00Z'),
      getLeaderStatus: () => leaderStatus,
      getAgentsHealth: () => healthyController,
      getSupportingHealth: () => healthyController,
      getOrchestrationHealth: () => healthyController,
      resolvePodIdentity: () => ({
        podName: 'agents-controllers-0',
        deploymentName: 'agents-controllers',
      }),
      createStore: () => ({
        ready: Promise.resolve(),
        close: async () => undefined,
        upsertHeartbeat,
        getHeartbeat: async () => null,
      }),
    })

    expect(published).toBe(4)
    expect(upsertHeartbeat).toHaveBeenCalledTimes(4)
    expect(upsertHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'agents',
        component: 'agents-controller',
        workloadRole: 'controllers',
        podName: 'agents-controllers-0',
        deploymentName: 'agents-controllers',
        leadershipState: 'leader',
        status: 'healthy',
      }),
    )
    expect(upsertHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'workflow-runtime',
        status: 'healthy',
      }),
    )
  })

  it('does not publish controller heartbeats from follower replicas', async () => {
    const upsertHeartbeat = vi.fn(async () => undefined)

    const published = await publishControlPlaneHeartbeatsOnce({
      now: () => new Date('2026-03-08T12:00:00Z'),
      getLeaderStatus: () => followerStatus,
      getAgentsHealth: () => healthyController,
      getSupportingHealth: () => healthyController,
      getOrchestrationHealth: () => healthyController,
      createStore: () => ({
        ready: Promise.resolve(),
        close: async () => undefined,
        upsertHeartbeat,
        getHeartbeat: async () => null,
      }),
    })

    expect(published).toBe(0)
    expect(upsertHeartbeat).not.toHaveBeenCalled()
  })

  it('publishes disabled rows when the authoritative workload disables a component', async () => {
    const upsertHeartbeat = vi.fn(async () => undefined)

    await publishControlPlaneHeartbeatsOnce({
      now: () => new Date('2026-03-08T12:00:00Z'),
      getLeaderStatus: () => leaderStatus,
      getAgentsHealth: () => ({
        ...healthyController,
        enabled: false,
        started: false,
      }),
      getSupportingHealth: () => healthyController,
      getOrchestrationHealth: () => healthyController,
      createStore: () => ({
        ready: Promise.resolve(),
        close: async () => undefined,
        upsertHeartbeat,
        getHeartbeat: async () => null,
      }),
    })

    expect(upsertHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'agents-controller',
        enabled: false,
        status: 'disabled',
        message: 'agents controller disabled',
      }),
    )
    expect(upsertHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'workflow-runtime',
        enabled: false,
        status: 'disabled',
        message: 'workflow runtime disabled',
      }),
    )
  })

  it('recreates the shared store after a publish failure so the next tick can recover', async () => {
    vi.useFakeTimers()

    const failure = new Error('transient heartbeat store failure')
    const failingStore = {
      ready: Promise.reject(failure),
      close: vi.fn(async () => undefined),
      upsertHeartbeat: vi.fn(async () => Promise.reject(failure)),
      getHeartbeat: vi.fn(async () => null),
    }
    const recoveredUpsert = vi.fn(async () => undefined)
    const recoveredStore = {
      ready: Promise.resolve(),
      close: vi.fn(async () => undefined),
      upsertHeartbeat: recoveredUpsert,
      getHeartbeat: vi.fn(async () => null),
    }

    let createCount = 0
    const createStore = vi.fn(() => {
      createCount += 1
      return createCount === 1 ? failingStore : recoveredStore
    })
    const logWarning = vi.fn()

    startControlPlaneHeartbeatPublisher({
      now: () => new Date('2026-03-08T12:00:00Z'),
      getLeaderStatus: () => leaderStatus,
      getAgentsHealth: () => healthyController,
      getSupportingHealth: () => healthyController,
      getOrchestrationHealth: () => healthyController,
      resolvePodIdentity: () => ({
        podName: 'agents-controllers-0',
        deploymentName: 'agents-controllers',
      }),
      createStore,
      logWarning,
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(createStore).toHaveBeenCalledTimes(1)
    expect(failingStore.close).toHaveBeenCalledTimes(1)
    expect(logWarning).toHaveBeenCalledWith('control-plane heartbeat publish failed', failure)

    await vi.advanceTimersByTimeAsync(resolveControlPlaneHeartbeatIntervalSeconds() * 1000)

    expect(createStore).toHaveBeenCalledTimes(2)
    expect(recoveredUpsert).toHaveBeenCalledTimes(4)
  })
})
