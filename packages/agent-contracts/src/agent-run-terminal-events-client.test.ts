import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ackAgentRunTerminalEventViaAgentsService,
  fetchAgentRunTerminalEventsFromAgentsService,
} from './agent-run-terminal-events-client'

describe('agent-run-terminal-events-client', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('lists terminal AgentRun events through the Agents service boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        namespace: 'agents',
        consumer: 'finalizer',
        total: 1,
        events: [{ eventId: 'agents/run-1/uid-1/Succeeded' }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchAgentRunTerminalEventsFromAgentsService(
      {
        namespace: 'agents',
        runIdPrefix: 'run-',
        consumer: 'finalizer',
        limit: 25,
      },
      {
        AGENTS_SERVICE_BASE_URL: 'http://agents.test',
        AGENTS_SERVICE_CLIENT_NAME: 'terminal-events-test',
      },
    )

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe(
      'http://agents.test/v1/agent-runs/terminal-events?namespace=agents&runIdPrefix=run-&consumer=finalizer&limit=25',
    )
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-agents-client': 'terminal-events-test',
      },
    })
  })

  it('acks a terminal AgentRun event through the Agents service boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        eventId: 'agents/run-1/uid-1/Succeeded',
        name: 'run-1',
        namespace: 'agents',
        consumer: 'finalizer',
        resource: { kind: 'AgentRun' },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await ackAgentRunTerminalEventViaAgentsService(
      {
        eventId: 'agents/run-1/uid-1/Succeeded',
        consumer: 'finalizer',
        outcome: 'finalized',
        message: 'done',
        receiptRef: 'receipt-1',
      },
      {
        AGENTS_SERVICE_BASE_URL: 'http://agents.test',
        AGENTS_SERVICE_CLIENT_NAME: 'terminal-events-test',
      },
    )

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0].toString()).toBe('http://agents.test/v1/agent-runs/terminal-events/ack')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-agents-client': 'terminal-events-test',
      },
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      eventId: 'agents/run-1/uid-1/Succeeded',
      consumer: 'finalizer',
      outcome: 'finalized',
      message: 'done',
      receiptRef: 'receipt-1',
    })
  })
})
