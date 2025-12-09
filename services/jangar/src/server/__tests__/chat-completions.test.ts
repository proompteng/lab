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

  it('streams tool calls and reasoning deltas in OpenAI-compatible chunks', async () => {
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'hi there' }
          yield { type: 'reasoning', delta: 'thinking...' }
          yield {
            type: 'tool',
            toolKind: 'command',
            id: 'tool-1',
            status: 'started',
            title: 'ls',
          }
          yield {
            type: 'tool',
            toolKind: 'command',
            id: 'tool-1',
            status: 'delta',
            title: 'ls',
            detail: 'output chunk',
          }
          yield {
            type: 'tool',
            toolKind: 'webSearch',
            id: 'tool-2',
            status: 'completed',
            title: 'search',
            detail: 'done',
          }
          yield {
            type: 'tool',
            toolKind: 'command',
            id: 'tool-1',
            status: 'completed',
            title: 'ls',
            detail: 'exit 0',
          }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 2 } }
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
    const chunks = text
      .trim()
      .split('\n\n')
      .map((part) => part.replace(/^data: /, ''))
      .filter((part) => part !== '[DONE]')
      .map((part) => JSON.parse(part))

    const toolChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls)
    expect(toolChunks.length).toBeGreaterThanOrEqual(3)

    const firstTool = toolChunks[0].choices[0].delta.tool_calls[0]
    expect(firstTool.id).toBe('tool-1')
    expect(firstTool.index).toBe(0)
    expect(firstTool.function.name).toBe('command')
    expect(firstTool.function.arguments.startsWith('[')).toBe(true)
    const hasClosingArguments = toolChunks.some((chunk) => {
      const args = chunk.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments
      return typeof args === 'string' && args.endsWith(']')
    })
    expect(hasClosingArguments).toBe(true)

    const reasoningChunk = chunks.find((c) => c.choices?.[0]?.delta?.reasoning_content)
    expect(reasoningChunk?.choices?.[0]?.delta?.reasoning_content?.[0]?.text).toContain('thinking')

    const usageChunk = chunks.find((c) => c.usage)
    expect(usageChunk?.usage?.output_tokens).toBe(2)
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
    expect(text.trim().endsWith('[DONE]')).toBe(true)
  })
})
