import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildExecutionTrust } from '~/server/control-plane-execution-trust'
import type { KubeGateway, KubeGatewaySwarm } from '~/server/kube-gateway'

const createTestKubeGateway = (overrides: Partial<KubeGateway> = {}): KubeGateway => ({
  listAgentRuns: vi.fn(async () => []),
  listJobs: vi.fn(async () => []),
  listPods: vi.fn(async () => []),
  listEvents: vi.fn(async () => []),
  listNamespaces: vi.fn(async () => []),
  listCustomResourceDefinitions: vi.fn(async () => []),
  getLease: vi.fn(async () => null),
  createLease: vi.fn(async () => {
    throw new Error('not implemented in test gateway')
  }),
  replaceLease: vi.fn(async () => {
    throw new Error('not implemented in test gateway')
  }),
  serviceExists: vi.fn(async () => true),
  listSwarms: vi.fn(async () => []),
  ...overrides,
})

const buildExecutionTrustSwarmResource = (
  options: {
    metadataGeneration?: number
    observedGeneration?: number | null
    phase?: string
    freezeReason?: string | null
    freezeUntil?: string | null
    requirementsPending?: number
    requirementsLastSeen?: string | null
    stageStates?: Record<string, Record<string, string | number | boolean>>
  } = {},
): KubeGatewaySwarm => ({
  metadata: {
    name: 'jangar-control-plane',
    namespace: 'agents',
    generation: options.metadataGeneration ?? 1,
    labels: {},
    creationTimestamp: '2026-01-20T00:00:00Z',
  },
  status: {
    observedGeneration: options.observedGeneration ?? 4,
    phase: options.phase ?? 'Active',
    freeze: {
      reason: options.freezeReason ?? null,
      until: options.freezeUntil ?? null,
    },
    requirements: {
      pending: options.requirementsPending ?? 0,
    },
    lastDiscoverAt: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
    lastPlanAt: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
    lastImplementAt: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
    lastVerifyAt: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
    stageStates: {
      discover: {
        phase: 'Running',
        healthy: true,
        cadence: '1m',
        lastRunTime: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
        consecutiveFailures: 0,
      },
      plan: {
        phase: 'Running',
        healthy: true,
        cadence: '1m',
        lastRunTime: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
        consecutiveFailures: 0,
      },
      implement: {
        phase: 'Running',
        healthy: true,
        cadence: '1m',
        lastRunTime: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
        consecutiveFailures: 0,
      },
      verify: {
        phase: 'Running',
        healthy: true,
        cadence: '1m',
        lastRunTime: options.requirementsLastSeen ?? '2026-01-20T00:00:00Z',
        consecutiveFailures: 0,
      },
      ...options.stageStates,
    },
  },
})

describe('control-plane execution trust', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('marks blocked trust when a tracked swarm has an active non-recovery freeze', async () => {
    const kubeGateway = createTestKubeGateway({
      listSwarms: vi.fn(async () => [
        buildExecutionTrustSwarmResource({
          phase: 'Frozen',
          freezeReason: 'ConsecutiveFailures',
          freezeUntil: '2026-01-20T00:40:00Z',
          requirementsPending: 2,
          requirementsLastSeen: '2026-01-20T00:00:00Z',
          stageStates: {
            discover: {
              phase: 'Frozen',
              healthy: false,
              cadence: '1m',
              lastRunTime: '2026-01-20T00:00:00Z',
              consecutiveFailures: 1,
            },
          },
        }),
      ]),
    })

    const snapshot = await buildExecutionTrust({
      namespace: 'agents',
      now: new Date('2026-01-20T00:20:00Z'),
      swarms: ['jangar-control-plane'],
      kube: kubeGateway,
      summaryLimit: 20,
    })

    expect(snapshot.executionTrust.status).toBe('blocked')
    expect(snapshot.executionTrust.reason).toContain('execution trust blocked')
    expect(snapshot.executionTrust.blocking_windows.some((window) => window.class === 'blocked')).toBe(true)
    expect(snapshot.swarms[0]?.freeze).toMatchObject({ reason: 'ConsecutiveFailures' })
    expect(snapshot.stages.some((stage) => stage.phase === 'Frozen')).toBe(true)
  })

  it('degrades instead of blocking during active stale-stage recovery freezes', async () => {
    const kubeGateway = createTestKubeGateway({
      listSwarms: vi.fn(async () => [
        buildExecutionTrustSwarmResource({
          phase: 'Frozen',
          freezeReason: 'StageStaleness',
          freezeUntil: '2026-01-20T00:40:00Z',
          requirementsPending: 2,
          requirementsLastSeen: '2026-01-20T00:00:00Z',
          stageStates: {
            discover: {
              phase: 'Frozen',
              healthy: false,
              cadence: '1m',
              lastRunTime: '2026-01-20T00:00:00Z',
              consecutiveFailures: 0,
            },
          },
        }),
      ]),
    })

    const snapshot = await buildExecutionTrust({
      namespace: 'agents',
      now: new Date('2026-01-20T00:20:00Z'),
      swarms: ['jangar-control-plane'],
      kube: kubeGateway,
      summaryLimit: 20,
    })

    expect(snapshot.executionTrust.status).toBe('degraded')
    expect(snapshot.executionTrust.blocking_windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'swarms',
          name: 'jangar-control-plane',
          reason: 'swarm freeze active (StageStaleness)',
          class: 'degraded',
        }),
        expect.objectContaining({
          type: 'stages',
          name: 'jangar-control-plane:discover',
          reason: 'discover delayed by swarm freeze',
          class: 'degraded',
        }),
      ]),
    )
  })

  it('ignores inactive NotFrozen freeze records with future timestamps', async () => {
    const kubeGateway = createTestKubeGateway({
      listSwarms: vi.fn(async () => [
        buildExecutionTrustSwarmResource({
          phase: 'Frozen',
          freezeReason: 'NotFrozen',
          freezeUntil: '2026-01-20T00:40:00Z',
          requirementsPending: 0,
          requirementsLastSeen: '2026-01-20T00:19:00Z',
          stageStates: {
            discover: {
              phase: 'Frozen',
              healthy: true,
              fresh: true,
              cadence: '1m',
              recentSuccessAt: '2026-01-20T00:19:00Z',
              consecutiveFailures: 0,
            },
            plan: {
              phase: 'Frozen',
              healthy: true,
              fresh: true,
              cadence: '1m',
              recentSuccessAt: '2026-01-20T00:19:00Z',
              consecutiveFailures: 0,
            },
            implement: {
              phase: 'Frozen',
              healthy: true,
              fresh: true,
              cadence: '1m',
              recentSuccessAt: '2026-01-20T00:19:00Z',
              consecutiveFailures: 0,
            },
            verify: {
              phase: 'Frozen',
              healthy: true,
              fresh: true,
              cadence: '1m',
              recentSuccessAt: '2026-01-20T00:19:00Z',
              consecutiveFailures: 0,
            },
          },
        }),
      ]),
    })

    const snapshot = await buildExecutionTrust({
      namespace: 'agents',
      now: new Date('2026-01-20T00:20:00Z'),
      swarms: ['jangar-control-plane'],
      kube: kubeGateway,
      summaryLimit: 20,
    })

    expect(snapshot.executionTrust.status).toBe('healthy')
    expect(snapshot.executionTrust.blocking_windows).toEqual([])
    expect(snapshot.swarms[0]).toMatchObject({
      phase: 'Active',
      ready: true,
      freeze: {
        reason: 'NotFrozen',
        until: '2026-01-20T00:40:00Z',
      },
    })
    expect(snapshot.stages.map((stage) => stage.phase)).toEqual(['Active', 'Active', 'Active', 'Active'])
  })

  it('uses recent stage successes when schedule lastRunTime is stale', async () => {
    const recentSuccessAt = '2026-01-20T02:30:00Z'
    const staleRunAt = '2026-01-20T00:00:00Z'
    const kubeGateway = createTestKubeGateway({
      listSwarms: vi.fn(async () => [
        buildExecutionTrustSwarmResource({
          phase: 'Active',
          requirementsPending: 0,
          requirementsLastSeen: staleRunAt,
          stageStates: {
            discover: {
              phase: 'Active',
              healthy: false,
              fresh: false,
              cadence: '1h',
              lastRunTime: staleRunAt,
              recentSuccessAt,
              consecutiveFailures: 0,
            },
            plan: {
              phase: 'Active',
              healthy: false,
              fresh: false,
              cadence: '1h',
              lastRunTime: staleRunAt,
              recentSuccessAt,
              consecutiveFailures: 0,
            },
            implement: {
              phase: 'Active',
              healthy: false,
              fresh: false,
              cadence: '1h',
              lastRunTime: staleRunAt,
              recentSuccessAt,
              consecutiveFailures: 0,
            },
            verify: {
              phase: 'Active',
              healthy: false,
              fresh: false,
              cadence: '1h',
              lastRunTime: staleRunAt,
              recentSuccessAt,
              consecutiveFailures: 0,
            },
          },
        }),
      ]),
    })

    const snapshot = await buildExecutionTrust({
      namespace: 'agents',
      now: new Date('2026-01-20T03:00:00Z'),
      swarms: ['jangar-control-plane'],
      kube: kubeGateway,
      summaryLimit: 20,
    })

    expect(snapshot.executionTrust.status).toBe('healthy')
    expect(snapshot.executionTrust.blocking_windows).toHaveLength(0)
    expect(snapshot.stages.every((stage) => stage.last_run_at === new Date(recentSuccessAt).toISOString())).toBe(true)
    expect(snapshot.stages.every((stage) => stage.stale === false)).toBe(true)
  })

  it('prefers status observed generation over metadata generation', async () => {
    const kubeGateway = createTestKubeGateway({
      listSwarms: vi.fn(async () => [
        buildExecutionTrustSwarmResource({
          metadataGeneration: 9,
          observedGeneration: 4,
        }),
      ]),
    })

    const snapshot = await buildExecutionTrust({
      namespace: 'agents',
      now: new Date('2026-01-20T00:20:00Z'),
      swarms: ['jangar-control-plane'],
      kube: kubeGateway,
      summaryLimit: 20,
    })

    expect(snapshot.swarms[0]?.observed_generation).toBe(4)
  })
})
