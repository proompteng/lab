import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getAgentEvents } from './events'

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
          workflowUid: null,
          workflowName: null,
          workflowNamespace: null,
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

    const request = new Request('http://localhost/api/agents/events?channel=general&limit=1')
    const response = await getAgentEvents(request)

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    if (!reader) throw new Error('Missing response body reader')

    const first = await reader.read()
    expect(first.done).toBe(false)
    const firstText = decodeChunk(first.value)
    expect(firstText).toContain('retry: 1000')
    expect(firstText).toContain(': connected')

    const heartbeatRead = reader.read()
    await vi.advanceTimersByTimeAsync(5000)
    const heartbeat = await heartbeatRead

    expect(heartbeat.done).toBe(false)
    expect(decodeChunk(heartbeat.value)).toContain(': keep-alive')

    await reader.cancel()
  })
})
