import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getAgentEvents } from './agent-events'

const listMessagesMock = vi.fn()
const closeMock = vi.fn(async () => {})

vi.mock('~/server/metrics', () => ({
  recordSseConnection: vi.fn(),
  recordSseError: vi.fn(),
}))

vi.mock('~/server/agent-comms-subscriber', () => ({
  startAgentCommsSubscriber: vi.fn(async () => {}),
}))

vi.mock('~/server/agent-messages-store', () => ({
  createAgentMessagesStore: () => ({
    listMessages: listMessagesMock,
    close: closeMock,
  }),
}))

const decodeChunk = (chunk?: Uint8Array) => (chunk ? new TextDecoder().decode(chunk) : '')

describe('getAgentEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    listMessagesMock.mockReset()
    closeMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the SSE stream open and emits keep-alives', async () => {
    const createdAt = new Date().toISOString()
    listMessagesMock
      .mockResolvedValueOnce([
        {
          id: 'msg-1',
          agentRunUid: 'agent-run-uid',
          agentRunName: 'demo',
          agentRunNamespace: 'agents',
          runId: null,
          stepId: null,
          agentId: 'agent-1',
          role: 'assistant',
          kind: 'status',
          timestamp: createdAt,
          channel: 'general',
          stage: 'status',
          content: 'hello',
          attrs: {},
          dedupeKey: null,
          createdAt,
        },
      ])
      .mockResolvedValue([])

    const request = new Request('http://localhost/v1/agent-events?channel=general&limit=1')
    const response = await getAgentEvents(request)

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    if (!reader) throw new Error('Missing response body reader')

    let bootText = ''
    for (let attempt = 0; attempt < 3 && !bootText.includes(': connected'); attempt += 1) {
      const chunk = await reader.read()
      expect(chunk.done).toBe(false)
      bootText += decodeChunk(chunk.value)
    }
    expect(bootText).toContain('retry: 1000')
    expect(bootText).toContain(': connected')

    let dataText = bootText
    for (let attempt = 0; attempt < 4 && !dataText.includes('data:'); attempt += 1) {
      const chunk = await reader.read()
      expect(chunk.done).toBe(false)
      dataText += decodeChunk(chunk.value)
    }
    expect(dataText).toContain('"agent_run_uid":"agent-run-uid"')
    expect(dataText).toContain('"agent_run_name":"demo"')
    expect(dataText).not.toContain('"workflow_uid"')

    await vi.advanceTimersByTimeAsync(5000)
    let heartbeatText = ''
    for (let attempt = 0; attempt < 3 && !heartbeatText.includes(': keep-alive'); attempt += 1) {
      const chunk = await reader.read()
      expect(chunk.done).toBe(false)
      heartbeatText += decodeChunk(chunk.value)
    }
    expect(heartbeatText).toContain(': keep-alive')

    await reader.cancel()
  })

  it('accepts AgentRun name and namespace as the event stream identity', async () => {
    const createdAt = new Date().toISOString()
    listMessagesMock.mockResolvedValueOnce([
      {
        id: 'msg-1',
        agentRunUid: null,
        agentRunName: 'demo',
        agentRunNamespace: 'agents',
        runId: null,
        stepId: null,
        agentId: 'agent-1',
        role: 'assistant',
        kind: 'status',
        timestamp: createdAt,
        channel: null,
        stage: 'status',
        content: 'hello by name',
        attrs: {},
        dedupeKey: null,
        createdAt,
      },
    ])

    const request = new Request('http://localhost/v1/agent-events?agentRunName=demo&agentRunNamespace=agents&limit=1')
    const response = await getAgentEvents(request)

    expect(response.status).toBe(200)
    expect(listMessagesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRunName: 'demo',
        agentRunNamespace: 'agents',
      }),
    )

    await response.body?.cancel()
  })
})
