import { beforeEach, describe, expect, it, vi } from 'vitest'

const agentsControllerMocks = vi.hoisted(() => ({
  getAgentsControllerHealth: vi.fn(),
  assessAgentRunIngestion: vi.fn(),
}))

const leaderElectionMocks = vi.hoisted(() => ({
  getLeaderElectionStatus: vi.fn(),
}))

const orchestrationControllerMocks = vi.hoisted(() => ({
  getOrchestrationControllerHealth: vi.fn(),
}))

const supportingControllerMocks = vi.hoisted(() => ({
  getSupportingControllerHealth: vi.fn(),
}))

const controlPlaneStatusMocks = vi.hoisted(() => ({
  buildExecutionTrust: vi.fn(),
}))

vi.mock('~/server/agents-controller', () => agentsControllerMocks)
vi.mock('~/server/leader-election', () => leaderElectionMocks)
vi.mock('~/server/orchestration-controller', () => orchestrationControllerMocks)
vi.mock('~/server/supporting-primitives-controller', () => supportingControllerMocks)
vi.mock('~/server/control-plane-status', async () => {
  const actual = await vi.importActual<typeof import('~/server/control-plane-status')>('~/server/control-plane-status')
  return {
    ...actual,
    buildExecutionTrust: controlPlaneStatusMocks.buildExecutionTrust,
  }
})

describe('getReadyHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    controlPlaneStatusMocks.buildExecutionTrust.mockReset()
    controlPlaneStatusMocks.buildExecutionTrust.mockResolvedValue({
      executionTrust: {
        status: 'healthy',
        reason: 'execution trust is healthy.',
        last_evaluated_at: '2026-03-08T21:00:00Z',
        blocking_windows: [],
        evidence_summary: [],
      },
      swarms: [],
      stages: [],
    })

    agentsControllerMocks.getAgentsControllerHealth.mockReturnValue({
      enabled: true,
      started: true,
      namespaces: ['agents'],
      crdsReady: true,
      missingCrds: [],
      lastCheckedAt: '2026-03-08T21:00:00Z',
      agentRunIngestion: [],
    })
    agentsControllerMocks.assessAgentRunIngestion.mockReturnValue({
      namespace: 'agents',
      status: 'healthy',
      message: 'AgentRun ingestion healthy',
      dispatchPaused: false,
      lastWatchEventAt: '2026-03-08T21:00:00Z',
      lastResyncAt: '2026-03-08T21:00:00Z',
      untouchedRunCount: 0,
      oldestUntouchedAgeSeconds: null,
    })
    leaderElectionMocks.getLeaderElectionStatus.mockReturnValue({
      enabled: true,
      required: true,
      isLeader: true,
      leaseName: 'jangar-controller-leader',
      leaseNamespace: 'agents',
      identity: 'agents-controllers-1',
      lastTransitionAt: '2026-03-08T21:00:00Z',
      lastAttemptAt: '2026-03-08T21:00:00Z',
      lastSuccessAt: '2026-03-08T21:00:00Z',
      lastError: null,
    })
    orchestrationControllerMocks.getOrchestrationControllerHealth.mockReturnValue({
      enabled: true,
      started: true,
      namespaces: ['agents'],
      crdsReady: true,
      missingCrds: [],
      lastCheckedAt: '2026-03-08T21:00:00Z',
    })
    supportingControllerMocks.getSupportingControllerHealth.mockReturnValue({
      enabled: true,
      started: true,
      namespaces: ['agents'],
      crdsReady: true,
      missingCrds: [],
      lastCheckedAt: '2026-03-08T21:00:00Z',
    })
  })

  it('returns 200 when leader is ready and AgentRun ingestion is healthy', async () => {
    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
  })

  it('returns 503 when AgentRun ingestion is degraded', async () => {
    agentsControllerMocks.assessAgentRunIngestion.mockReturnValue({
      namespace: 'agents',
      status: 'degraded',
      message: 'untouched AgentRuns detected for 180s',
      dispatchPaused: true,
      lastWatchEventAt: null,
      lastResyncAt: '2026-03-08T21:00:00Z',
      untouchedRunCount: 3,
      oldestUntouchedAgeSeconds: 180,
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.status).toBe('degraded')
  })

  it('returns 200 when leader election is required but this instance is a healthy standby', async () => {
    leaderElectionMocks.getLeaderElectionStatus.mockReturnValue({
      enabled: true,
      required: true,
      isLeader: false,
      leaseName: 'jangar-controller-leader',
      leaseNamespace: 'agents',
      identity: 'agents-controllers-2',
      lastTransitionAt: '2026-03-08T21:00:00Z',
      lastAttemptAt: '2026-03-08T21:00:00Z',
      lastSuccessAt: '2026-03-08T21:00:00Z',
      lastError: null,
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
  })

  it('returns 503 when leader election is required but standby has not observed a healthy lease attempt', async () => {
    leaderElectionMocks.getLeaderElectionStatus.mockReturnValue({
      enabled: true,
      required: true,
      isLeader: false,
      leaseName: 'jangar-controller-leader',
      leaseNamespace: 'agents',
      identity: 'agents-controllers-2',
      lastTransitionAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: 'lease watch failed',
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.status).toBe('degraded')
  })

  it('returns 200 when execution trust is healthy', async () => {
    controlPlaneStatusMocks.buildExecutionTrust.mockResolvedValue({
      executionTrust: {
        status: 'healthy',
        reason: 'execution trust is healthy.',
        last_evaluated_at: '2026-03-08T21:00:00Z',
        blocking_windows: [],
        evidence_summary: [],
      },
      swarms: [],
      stages: [],
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('ok')
    expect(body.execution_trust).toMatchObject({
      status: 'healthy',
    })
  })

  it('returns 503 when execution trust is blocked', async () => {
    controlPlaneStatusMocks.buildExecutionTrust.mockResolvedValue({
      executionTrust: {
        status: 'blocked',
        reason: 'execution trust blocked by stage staleness',
        last_evaluated_at: '2026-03-08T21:00:00Z',
        blocking_windows: [
          {
            type: 'swarms',
            scope: 'agents',
            name: 'jangar-control-plane',
            reason: 'requirements stalled',
            class: 'blocked',
          },
        ],
        evidence_summary: ['execution trust blocked'],
      },
      swarms: [],
      stages: [],
    })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.execution_trust).toMatchObject({
      status: 'blocked',
    })
  })

  it('returns 503 when any watched namespace reports blocked execution trust', async () => {
    agentsControllerMocks.getAgentsControllerHealth.mockReturnValue({
      enabled: true,
      started: true,
      namespaces: ['agents', 'staging'],
      crdsReady: true,
      missingCrds: [],
      lastCheckedAt: '2026-03-08T21:00:00Z',
      agentRunIngestion: [],
    })
    controlPlaneStatusMocks.buildExecutionTrust
      .mockResolvedValueOnce({
        executionTrust: {
          status: 'healthy',
          reason: 'execution trust is healthy.',
          last_evaluated_at: '2026-03-08T21:00:00Z',
          blocking_windows: [],
          evidence_summary: [],
        },
        swarms: [],
        stages: [],
      })
      .mockResolvedValueOnce({
        executionTrust: {
          status: 'blocked',
          reason: 'execution trust blocked by stage staleness',
          last_evaluated_at: '2026-03-08T21:00:00Z',
          blocking_windows: [
            {
              type: 'swarms',
              scope: 'staging',
              name: 'torghut-quant',
              reason: 'requirements stalled',
              class: 'blocked',
            },
          ],
          evidence_summary: ['execution trust blocked'],
        },
        swarms: [],
        stages: [],
      })

    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(503)
    expect(controlPlaneStatusMocks.buildExecutionTrust).toHaveBeenCalledTimes(2)
    expect(controlPlaneStatusMocks.buildExecutionTrust).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        namespace: 'agents',
      }),
    )
    expect(controlPlaneStatusMocks.buildExecutionTrust).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        namespace: 'staging',
      }),
    )
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.execution_trust).toMatchObject({
      status: 'blocked',
    })
    expect(body.execution_trust.reason).toContain('2 namespaces')
    expect(body.execution_trust.blocking_windows).toEqual([
      expect.objectContaining({
        scope: 'staging',
        class: 'blocked',
      }),
    ])
  })

  it('returns 503 when execution trust evaluation fails', async () => {
    controlPlaneStatusMocks.buildExecutionTrust.mockRejectedValue(new Error('trust fetch failed'))
    const { getReadyHandler } = await import('./ready')

    const response = await getReadyHandler()

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.execution_trust).toMatchObject({
      status: 'unknown',
    })
    expect(body.execution_trust.reason).toContain('execution trust check failed for namespace agents')
    expect(controlPlaneStatusMocks.buildExecutionTrust).toHaveBeenCalledTimes(1)
  })
})
