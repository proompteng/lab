import { describe, expect, it, vi } from 'vitest'

import { buildAgentsRuntimeReadyResponse, type AgentsControllerHealthState } from './ready'

const healthyController = (overrides: Partial<AgentsControllerHealthState> = {}): AgentsControllerHealthState => ({
  enabled: true,
  started: true,
  namespaces: ['agents'],
  crdsReady: true,
  missingCrds: [],
  lastCheckedAt: '2026-05-18T00:00:00.000Z',
  agentRunIngestion: [],
  ...overrides,
})

const readJson = async (response: Response) => (await response.json()) as Record<string, unknown>

describe('buildAgentsRuntimeReadyResponse', () => {
  it('returns the versioned agents readiness contract when controllers and leadership are ready', async () => {
    const assessAgentRunIngestion = vi.fn(() => ({
      namespace: 'agents',
      lastWatchEventAt: '2026-05-18T00:00:00.000Z',
      lastResyncAt: '2026-05-18T00:00:00.000Z',
      untouchedRunCount: 0,
      oldestUntouchedAgeSeconds: null,
      status: 'healthy' as const,
      message: 'healthy',
      dispatchPaused: false,
    }))

    const response = buildAgentsRuntimeReadyResponse({
      leaderElection: {
        required: true,
        isLeader: true,
        lastAttemptAt: '2026-05-18T00:00:00.000Z',
        lastError: null,
      },
      agentsController: healthyController(),
      orchestrationController: healthyController({ enabled: false, started: false, crdsReady: null }),
      supportingController: healthyController({ enabled: false, started: false, crdsReady: null }),
      assessAgentRunIngestion,
    })

    expect(response.status).toBe(200)
    expect(await readJson(response)).toMatchObject({
      schemaVersion: 'agents.proompteng.ai/ready/v1',
      status: 'ok',
      service: 'agents',
      httpReady: true,
      reason_codes: [],
      namespaces: ['agents'],
    })
    expect(assessAgentRunIngestion).toHaveBeenCalledWith('agents', expect.objectContaining({ enabled: true }))
  })

  it('keeps HTTP ready on a standby replica with healthy leader election', async () => {
    const response = buildAgentsRuntimeReadyResponse({
      leaderElection: {
        required: true,
        isLeader: false,
        lastAttemptAt: '2026-05-18T00:00:00.000Z',
        lastError: null,
      },
      agentsController: healthyController({ started: false }),
      orchestrationController: healthyController({ enabled: false, started: false, crdsReady: null }),
      supportingController: healthyController({ enabled: false, started: false, crdsReady: null }),
      assessAgentRunIngestion: vi.fn(),
    })

    expect(response.status).toBe(200)
    expect(await readJson(response)).toMatchObject({
      status: 'ok',
      httpReady: true,
    })
  })

  it('returns a 503 when controller CRDs are missing', async () => {
    const response = buildAgentsRuntimeReadyResponse({
      leaderElection: {
        required: true,
        isLeader: true,
        lastAttemptAt: '2026-05-18T00:00:00.000Z',
        lastError: null,
      },
      agentsController: healthyController({
        crdsReady: false,
        missingCrds: ['agentruns.agents.proompteng.ai'],
      }),
      orchestrationController: healthyController({ enabled: false, started: false, crdsReady: null }),
      supportingController: healthyController({ enabled: false, started: false, crdsReady: null }),
      assessAgentRunIngestion: vi.fn(() => ({
        namespace: 'agents',
        lastWatchEventAt: null,
        lastResyncAt: null,
        untouchedRunCount: 0,
        oldestUntouchedAgeSeconds: null,
        status: 'healthy' as const,
        message: 'healthy',
        dispatchPaused: false,
      })),
    })

    expect(response.status).toBe(503)
    expect(await readJson(response)).toMatchObject({
      status: 'degraded',
      httpReady: false,
      reason_codes: ['controller_crd_check_failed', 'missing_agents_controller_crd:agentruns.agents.proompteng.ai'],
    })
  })
})
