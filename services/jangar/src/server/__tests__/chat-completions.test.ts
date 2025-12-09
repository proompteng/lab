import type { CodexAppServerClient } from '@proompteng/codex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatCompletionsHandler } from '~/routes/openai/v1/chat/completions'
import { resetCodexClient, setCodexClientFactory } from '~/server/chat'

describe('chat completions handler', () => {
  beforeEach(() => {
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'hi there' }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 2 } }
        })(),
      }),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }
    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)
  })

  afterEach(() => {
    vi.clearAllMocks()
    resetCodexClient()
  })

  it('rejects non-streaming requests', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    })

    const response = await chatCompletionsHandler(request)

    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).toContain('stream_required')
  })

  it('proxies upstream SSE stream', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.1-codex', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })

    const response = await chatCompletionsHandler(request)

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('hi there')
    expect(response.headers.get('content-type')).toContain('text/event-stream')
  })

  it('deduplicates reasoning deltas and streams incremental reasoning_content', async () => {
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'reasoning', delta: 'Thinking' }
          yield { type: 'reasoning', delta: 'Thinking' }
          yield { type: 'reasoning', delta: 'Thinking harder' }
          yield { type: 'message', delta: 'final answer' }
          yield { type: 'usage', usage: { input_tokens: 3, output_tokens: 4 } }
        })(),
      }),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }
    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.1-codex', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })

    const response = await chatCompletionsHandler(request)
    const text = await response.text()

    const firstReasoningMatches = text.match(/"reasoning_content":"Thinking"/g) ?? []
    expect(firstReasoningMatches).toHaveLength(1)
    expect(text).toContain('"reasoning_content":" harder"')
    expect(text).toContain('final answer')
    expect(text).toContain('"usage"')
  })

  it('returns validation error when messages missing', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ stream: true }),
    })

    const response = await chatCompletionsHandler(request)
    expect(response.status).toBe(400)
    const json = await response.json()
    expect(json.error.message).toMatch(/messages/)
  })

  it('surfaces codex errors via SSE payload', async () => {
    const mockClient = {
      runTurnStream: async () => {
        throw new Error('boom')
      },
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }
    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.1-codex', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })

    const response = await chatCompletionsHandler(request)

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"code":"codex_error"')
    expect(text).not.toContain('"finish_reason":"stop"')
    expect(text.trim().endsWith('[DONE]')).toBe(true)
  })

  it('does not emit stop chunk when codex stream reports error delta', async () => {
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'partial' }
          yield { type: 'error', error: { message: 'stream exploded', code: 'oops' } }
        })(),
      }),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }
    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.1-codex', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })

    const response = await chatCompletionsHandler(request)
    const text = await response.text()

    expect(text).toContain('stream exploded')
    expect(text).not.toContain('"finish_reason":"stop"')
    expect(text.trim().endsWith('[DONE]')).toBe(true)
  })
})
