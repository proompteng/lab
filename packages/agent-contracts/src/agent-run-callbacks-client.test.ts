import { afterEach, describe, expect, it, vi } from 'vitest'

import { submitAgentRunCallbackToAgentsService } from './agent-run-callbacks-client'

describe('agent-run-callbacks-client', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('submits AgentRun callbacks to the Agents-owned endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ ok: true, callbackType: 'run_complete' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await submitAgentRunCallbackToAgentsService(
      {
        agentRunId: 'agent-run/name',
        callbackType: 'run_complete',
        payload: { phase: 'Succeeded' },
      },
      {
        AGENTS_SERVICE_BASE_URL: 'http://agents.test',
        AGENTS_SERVICE_CLIENT_NAME: 'callbacks-test',
      },
    )

    expect(result.ok).toBe(true)
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe('http://agents.test/v1/agent-runs/agent-run%2Fname/callbacks')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-agents-client': 'callbacks-test',
      },
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      phase: 'Succeeded',
      callbackType: 'run_complete',
    })
  })
})
