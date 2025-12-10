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

  it('emits tool calls immediately; command output is code fenced with separation', async () => {
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
            delta: 'output chunk\n1\n2\n3\n4\n5\n6',
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
          yield {
            type: 'tool',
            toolKind: 'command',
            id: 'tool-3',
            status: 'started',
            title: 'pwd',
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

    const toolCalls = chunks.map((c) => c.choices?.[0]?.delta?.tool_calls?.[0]).filter(Boolean) as Array<{
      id: string
      index: number
      function: { name: string; arguments: string }
    }>

    expect(toolCalls.length).toBe(0)

    const contentDeltas = chunks
      .map((c) => c.choices?.[0]?.delta?.content as string | undefined)
      .filter(Boolean) as string[]

    const fences = contentDeltas.filter((c) => c.includes('```'))
    expect(fences.length).toBeGreaterThanOrEqual(2)
    expect(contentDeltas.some((c) => c === 'ls')).toBe(true)
    expect(contentDeltas.some((c) => c.includes('output chunk'))).toBe(true)
    expect(contentDeltas.some((c) => c.includes('...'))).toBe(true)
    expect(contentDeltas.some((c) => c.includes('---'))).toBe(true)
    expect(contentDeltas.some((c) => c.includes('done'))).toBe(true)
    expect(contentDeltas.some((c) => c.includes('exit 0'))).toBe(true)
    expect(contentDeltas.some((c) => c.includes('pwd'))).toBe(true)
    expect((contentDeltas.at(-1) ?? '').includes('```')).toBe(true)

    const reasoningChunk = chunks.find((c) => c.choices?.[0]?.delta?.reasoning_content)
    expect(typeof reasoningChunk?.choices?.[0]?.delta?.reasoning_content).toBe('string')
    expect(reasoningChunk?.choices?.[0]?.delta?.content).toBeUndefined()

    const usageChunk = chunks.find((c) => c.usage)
    expect(usageChunk?.usage?.completion_tokens).toBe(2)
  })

  it('coalesces consecutive reasoning deltas into one chunk', async () => {
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'reasoning', delta: 'first ' }
          yield { type: 'reasoning', delta: 'second' }
          yield { type: 'message', delta: 'answer' }
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

    const reasoningChunks = chunks.filter((c) => c.choices?.[0]?.delta?.reasoning_content)
    expect(reasoningChunks).toHaveLength(1)
    expect(reasoningChunks[0].choices[0].delta.reasoning_content).toBe('first second')
    expect(reasoningChunks[0].choices[0].delta.content).toBeUndefined()
  })

  it('converts four asterisks in reasoning to a newline', async () => {
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'reasoning', delta: 'files****Planning' }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
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

    const reasoningChunk = chunks.find((c) => c.choices?.[0]?.delta?.reasoning_content)
    expect(reasoningChunk?.choices?.[0]?.delta?.reasoning_content).toBe('files\nPlanning')
    expect(reasoningChunk?.choices?.[0]?.delta?.content).toBeUndefined()
  })

  it('converts split asterisk runs across deltas into a newline', async () => {
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'reasoning', delta: '**' }
          yield { type: 'reasoning', delta: '**After' }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
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

    const reasoningChunk = chunks.find((c) => c.choices?.[0]?.delta?.reasoning_content)
    expect(reasoningChunk?.choices?.[0]?.delta?.reasoning_content).toBe('\nAfter')
    expect(reasoningChunk?.choices?.[0]?.delta?.content).toBeUndefined()
  })

  it('normalizes codex usage payloads and emits assistant role', async () => {
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'hello' }
          yield {
            type: 'usage',
            usage: {
              total: {
                totalTokens: 10,
                inputTokens: 6,
                cachedInputTokens: 2,
                outputTokens: 3,
                reasoningOutputTokens: 1,
              },
              last: {
                totalTokens: 10,
                inputTokens: 6,
                cachedInputTokens: 2,
                outputTokens: 3,
                reasoningOutputTokens: 1,
              },
            },
          }
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

    const firstMessageDelta = chunks.find((c) => c.choices?.[0]?.delta?.content)?.choices?.[0]?.delta
    expect(firstMessageDelta?.role).toBe('assistant')

    const usageChunk = chunks.find((c) => c.usage)
    expect(usageChunk?.usage?.prompt_tokens).toBe(6)
    expect(usageChunk?.usage?.completion_tokens).toBe(4) // output + reasoning
    expect(usageChunk?.usage?.total_tokens).toBe(10)
    expect(usageChunk?.usage?.prompt_tokens_details?.cached_tokens).toBe(2)
    expect(usageChunk?.usage?.completion_tokens_details?.reasoning_tokens).toBe(1)
  })

  it('keeps streaming after mid-turn usage updates and only finalizes once', async () => {
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'first ' }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 0 } }
          yield { type: 'message', delta: 'second' }
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

    const content = chunks
      .map((c) => c.choices?.[0]?.delta?.content as string | undefined)
      .filter(Boolean)
      .join('')

    expect(content).toBe('first second')

    const usageChunks = chunks.filter((c) => c.usage)
    expect(usageChunks).toHaveLength(1)
    expect(usageChunks[0].usage?.prompt_tokens).toBe(1)
    expect(usageChunks[0].usage?.completion_tokens).toBe(2)
  })

  it('does not hang when codex turn completes normally even if interruptTurn never resolves', async () => {
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'done' }
        })(),
      }),
      interruptTurn: vi.fn(() => new Promise(() => {})),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }
    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.1-codex', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })

    const response = await chatCompletionsHandler(request)
    const text = await Promise.race([
      response.text(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout waiting for stream end')), 1000)),
    ])

    expect(text.trim().endsWith('[DONE]')).toBe(true)
    expect(mockClient.interruptTurn).not.toHaveBeenCalled()
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
    const chunks = text
      .trim()
      .split('\n\n')
      .map((part) => part.replace(/^data: /, ''))
      .filter((part) => part !== '[DONE]')
      .map((part) => JSON.parse(part))
    const stopChunks = chunks.filter((c) => c.choices?.[0]?.finish_reason === 'stop')
    expect(stopChunks).toHaveLength(0)
  })
})
