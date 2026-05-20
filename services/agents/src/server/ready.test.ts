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
      agentrun_ingestion: [
        {
          namespace: 'agents',
          status: 'healthy',
          message: 'healthy',
          last_watch_event_at: '2026-05-18T00:00:00.000Z',
          last_resync_at: '2026-05-18T00:00:00.000Z',
          untouched_run_count: 0,
          oldest_untouched_age_seconds: null,
        },
      ],
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
      agentrun_ingestion: [
        {
          namespace: 'agents',
          status: 'unknown',
          message: 'AgentRun ingestion is owned by the active controller leader',
        },
      ],
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
      agentrun_ingestion: [
        {
          namespace: 'agents',
          status: 'healthy',
        },
      ],
    })
  })

  it('publishes degraded AgentRun ingestion as Agents-owned readiness evidence', async () => {
    const response = buildAgentsRuntimeReadyResponse({
      leaderElection: {
        required: true,
        isLeader: true,
        lastAttemptAt: '2026-05-18T00:00:00.000Z',
        lastError: null,
      },
      agentsController: healthyController({
        agentRunIngestion: [
          {
            namespace: 'agents',
            lastWatchEventAt: '2026-05-18T00:01:00.000Z',
            lastResyncAt: '2026-05-18T00:00:00.000Z',
            untouchedRunCount: 3,
            oldestUntouchedAgeSeconds: 120,
          },
        ],
      }),
      orchestrationController: healthyController({ enabled: false, started: false, crdsReady: null }),
      supportingController: healthyController({ enabled: false, started: false, crdsReady: null }),
      assessAgentRunIngestion: vi.fn(() => ({
        namespace: 'agents',
        lastWatchEventAt: '2026-05-18T00:01:00.000Z',
        lastResyncAt: '2026-05-18T00:00:00.000Z',
        untouchedRunCount: 3,
        oldestUntouchedAgeSeconds: 120,
        status: 'degraded' as const,
        message: '3 AgentRuns have not been reconciled',
        dispatchPaused: true,
      })),
    })

    expect(response.status).toBe(200)
    expect(await readJson(response)).toMatchObject({
      status: 'degraded',
      reason_codes: ['agentrun_ingestion_not_ready'],
      agentrun_ingestion: [
        {
          namespace: 'agents',
          status: 'degraded',
          message: '3 AgentRuns have not been reconciled',
          last_watch_event_at: '2026-05-18T00:01:00.000Z',
          last_resync_at: '2026-05-18T00:00:00.000Z',
          untouched_run_count: 3,
          oldest_untouched_age_seconds: 120,
        },
      ],
    })
  })
})
