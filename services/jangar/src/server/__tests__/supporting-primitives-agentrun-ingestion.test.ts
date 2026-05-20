import type { AgentsReadySnapshot } from '@proompteng/agent-contracts/agents-ready'
import { getAgentsReadySnapshot } from '@proompteng/agent-contracts/agents-ready'
import { describe, expect, it, vi } from 'vitest'

import { assessAgentRunIngestionViaAgentsService } from '~/server/supporting-primitives-agentrun-ingestion'

vi.mock('@proompteng/agent-contracts/agents-ready', () => ({
  getAgentsReadySnapshot: vi.fn(),
}))

const readySnapshot = (overrides: Partial<AgentsReadySnapshot> = {}): AgentsReadySnapshot => ({
  available: true,
  httpStatus: 200,
  status: 'ok',
  httpReady: true,
  reasonCodes: [],
  namespaces: ['agents'],
  leaderElection: {
    required: true,
    isLeader: true,
    lastAttemptAt: '2026-05-20T05:20:00.000Z',
    lastError: null,
  },
  agentRunIngestion: [
    {
      namespace: 'agents',
      status: 'healthy',
      message: 'healthy',
      last_watch_event_at: '2026-05-20T05:19:00.000Z',
      last_resync_at: '2026-05-20T05:18:00.000Z',
      untouched_run_count: 0,
      oldest_untouched_age_seconds: null,
    },
  ],
  agentsController: {
    enabled: true,
    started: true,
    namespaces: ['agents'],
    crdsReady: true,
    missingCrds: [],
    lastCheckedAt: '2026-05-20T05:20:00.000Z',
  },
  orchestrationController: {
    enabled: true,
    started: true,
    namespaces: ['agents'],
    crdsReady: true,
    missingCrds: [],
    lastCheckedAt: '2026-05-20T05:20:00.000Z',
  },
  supportingController: {
    enabled: true,
    started: true,
    namespaces: ['agents'],
    crdsReady: true,
    missingCrds: [],
    lastCheckedAt: '2026-05-20T05:20:00.000Z',
  },
  raw: {},
  error: null,
  ...overrides,
})

describe('supporting primitives AgentRun ingestion assessment', () => {
  it('uses the typed Agents readiness client instead of fetching /ready directly', async () => {
    vi.mocked(getAgentsReadySnapshot).mockResolvedValue(readySnapshot())

    const assessment = await assessAgentRunIngestionViaAgentsService('agents')

    expect(getAgentsReadySnapshot).toHaveBeenCalledTimes(1)
    expect(assessment).toMatchObject({
      namespace: 'agents',
      status: 'healthy',
      message: 'AgentRun ingestion healthy',
      lastWatchEventAt: '2026-05-20T05:19:00.000Z',
      lastResyncAt: '2026-05-20T05:18:00.000Z',
      untouchedRunCount: 0,
      oldestUntouchedAgeSeconds: null,
      dispatchPaused: false,
    })
  })

  it('pauses dispatch when Agents readiness reports AgentRun ingestion degradation', async () => {
    vi.mocked(getAgentsReadySnapshot).mockResolvedValue(
      readySnapshot({
        status: 'degraded',
        reasonCodes: ['agentrun_ingestion_not_ready'],
        agentRunIngestion: [
          {
            namespace: 'agents',
            status: 'degraded',
            message: '3 AgentRuns have not been reconciled',
            last_watch_event_at: null,
            last_resync_at: '2026-05-20T05:18:00.000Z',
            untouched_run_count: 3,
            oldest_untouched_age_seconds: 120,
          },
        ],
      }),
    )

    await expect(assessAgentRunIngestionViaAgentsService('agents')).resolves.toMatchObject({
      status: 'degraded',
      message: 'AgentRun ingestion not ready according to Agents service',
      untouchedRunCount: 3,
      oldestUntouchedAgeSeconds: 120,
      dispatchPaused: true,
    })
  })

  it('returns unknown when the typed Agents readiness client is unavailable', async () => {
    vi.mocked(getAgentsReadySnapshot).mockResolvedValue(
      readySnapshot({
        available: false,
        httpStatus: 0,
        status: 'degraded',
        httpReady: false,
        error: 'connection refused',
      }),
    )

    await expect(assessAgentRunIngestionViaAgentsService('agents')).resolves.toMatchObject({
      status: 'unknown',
      message: 'Agents readiness unavailable: connection refused',
      dispatchPaused: false,
    })
  })
})
