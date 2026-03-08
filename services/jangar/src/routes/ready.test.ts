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

vi.mock('~/server/agents-controller', () => agentsControllerMocks)
vi.mock('~/server/leader-election', () => leaderElectionMocks)
vi.mock('~/server/orchestration-controller', () => orchestrationControllerMocks)
vi.mock('~/server/supporting-primitives-controller', () => supportingControllerMocks)

describe('getReadyHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()

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

  it('returns 503 when leader election is required but this instance is not leader', async () => {
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

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.status).toBe('degraded')
  })
})
