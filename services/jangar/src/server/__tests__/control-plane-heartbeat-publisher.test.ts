import { afterEach, describe, expect, it, vi } from 'vitest'

import { publishControlPlaneHeartbeatsOnce } from '~/server/control-plane-heartbeat-publisher'

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
  afterEach(() => {
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
})
