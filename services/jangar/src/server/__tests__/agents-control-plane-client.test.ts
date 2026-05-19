import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildAgentsReadySnapshot,
  buildAgentsRuntimeReadyResponse,
  getAgentsReadySnapshot,
} from '../agents-control-plane-client'

const originalFetch = globalThis.fetch

describe('agents-control-plane-client', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('keeps a degraded Agents /ready payload authoritative when HTTP status is 503', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          schemaVersion: 'agents.proompteng.ai/ready/v1',
          status: 'degraded',
          service: 'agents',
          httpReady: false,
          reason_codes: ['leader_election_not_ready'],
          namespaces: ['agents'],
          leaderElection: {
            required: true,
            isLeader: false,
            lastAttemptAt: null,
            lastError: 'lease watch failed',
          },
          agentsController: {
            enabled: true,
            started: false,
            namespaces: ['agents'],
            crdsReady: true,
            missingCrds: [],
            lastCheckedAt: '2026-03-08T21:00:00Z',
            agentRunIngestion: [],
          },
        }),
        {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'content-type': 'application/json' },
        },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const snapshot = await getAgentsReadySnapshot()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(snapshot).toMatchObject({
      available: true,
      httpStatus: 503,
      status: 'degraded',
      httpReady: false,
      reasonCodes: ['leader_election_not_ready'],
      leaderElection: {
        lastError: 'lease watch failed',
      },
    })

    const response = buildAgentsRuntimeReadyResponse(snapshot)
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      reason_codes: ['leader_election_not_ready'],
    })
  })

  it('builds a degraded fallback snapshot when Agents /ready is unavailable', () => {
    const snapshot = buildAgentsReadySnapshot({
      payload: null,
      httpStatus: 0,
      error: 'connect ECONNREFUSED',
    })

    expect(snapshot).toMatchObject({
      available: false,
      status: 'degraded',
      httpReady: false,
      error: 'connect ECONNREFUSED',
      agentsController: {
        enabled: true,
        started: false,
        crdsReady: false,
      },
    })
  })
})
