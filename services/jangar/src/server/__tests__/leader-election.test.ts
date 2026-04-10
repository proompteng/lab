import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getLease: vi.fn(),
  createLease: vi.fn(),
  replaceLease: vi.fn(),
  listDeployments: vi.fn(),
  listJobs: vi.fn(),
  listNamespaces: vi.fn(),
  listCustomResourceDefinitions: vi.fn(),
  probeNamespacedResource: vi.fn(),
  serviceExists: vi.fn(),
  listSwarms: vi.fn(),
  meterAdd: vi.fn(),
  resolveLeaderElectionSettings: vi.fn(() => ({
    enabled: true,
    required: true,
    leaseName: 'jangar-controller-leader',
    leaseNamespace: 'agents',
    leaseDurationSeconds: 30,
    renewDeadlineSeconds: 20,
    retryPeriodSeconds: 5,
    podNamespace: 'agents',
    podName: 'jangar-0',
    podUid: 'pod-uid',
  })),
}))

vi.mock('../kube-gateway', () => ({
  createKubeGateway: () => ({
    getLease: mocks.getLease,
    createLease: mocks.createLease,
    replaceLease: mocks.replaceLease,
    listDeployments: mocks.listDeployments,
    listJobs: mocks.listJobs,
    listNamespaces: mocks.listNamespaces,
    listCustomResourceDefinitions: mocks.listCustomResourceDefinitions,
    probeNamespacedResource: mocks.probeNamespacedResource,
    serviceExists: mocks.serviceExists,
    listSwarms: mocks.listSwarms,
  }),
}))

vi.mock('../control-plane-config', () => ({
  isRuntimeTestEnv: () => false,
  resolveLeaderElectionSettings: mocks.resolveLeaderElectionSettings,
}))

vi.mock('@proompteng/otel/api', () => ({
  metrics: {
    getMeter: () => ({
      createCounter: () => ({
        add: mocks.meterAdd,
      }),
    }),
  },
}))

const stopLeaderElectionRuntime = () => {
  const state = globalThis as typeof globalThis & {
    __jangarLeaderElection?: { stop?: () => void }
  }
  state.__jangarLeaderElection?.stop?.()
  Reflect.deleteProperty(state, '__jangarLeaderElection')
}

describe('leader election', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    stopLeaderElectionRuntime()
  })

  afterEach(() => {
    stopLeaderElectionRuntime()
    vi.useRealTimers()
  })

  it('creates the lease when the initial read returns null and then promotes to leader', async () => {
    mocks.getLease.mockResolvedValueOnce(null)
    mocks.createLease.mockResolvedValueOnce({
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: {
        name: 'jangar-controller-leader',
        namespace: 'agents',
        resourceVersion: '1',
      },
      spec: {
        holderIdentity: 'jangar-0_pod-uid',
        leaseDurationSeconds: 30,
        leaseTransitions: 0,
        renewTime: new Date().toISOString(),
      },
    })
    mocks.replaceLease.mockResolvedValueOnce({
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: {
        name: 'jangar-controller-leader',
        namespace: 'agents',
        resourceVersion: '2',
      },
      spec: {
        holderIdentity: 'jangar-0_pod-uid',
        leaseDurationSeconds: 30,
        leaseTransitions: 0,
        renewTime: new Date().toISOString(),
      },
    })

    const onLeader = vi.fn()
    const onFollower = vi.fn()
    const { ensureLeaderElectionRuntime, getLeaderElectionStatus } = await import('../leader-election')

    ensureLeaderElectionRuntime({ onLeader, onFollower })

    await vi.waitFor(() => {
      expect(mocks.createLease).toHaveBeenCalledTimes(1)
      expect(mocks.replaceLease).toHaveBeenCalledTimes(1)
      expect(onLeader).toHaveBeenCalledTimes(1)
    })

    const status = getLeaderElectionStatus()
    expect(status.isLeader).toBe(true)
    expect(status.lastSuccessAt).not.toBeNull()
    expect(onFollower).toHaveBeenCalledTimes(1)
  })
})
