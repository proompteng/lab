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
      body: JSON.stringify({
        model: 'gpt-5.1-codex',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
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
      body: JSON.stringify({
        model: 'gpt-5.1-codex',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
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
    expect(contentDeltas.some((c) => c.startsWith('ls'))).toBe(true)
    expect(contentDeltas.some((c) => c.includes('output chunk'))).toBe(true)
    expect(contentDeltas.some((c) => c.includes('...'))).toBe(true)
    expect(contentDeltas.some((c) => c.includes('---'))).toBe(true)
    expect(contentDeltas.some((c) => c.includes('exit 0'))).toBe(true)
    expect(contentDeltas.some((c) => c.includes('pwd'))).toBe(true)
    expect((contentDeltas.at(-1) ?? '').includes('```')).toBe(true)

    const reasoningChunk = chunks.find((c) => c.choices?.[0]?.delta?.reasoning_content)
    expect(typeof reasoningChunk?.choices?.[0]?.delta?.reasoning_content).toBe('string')
    expect(reasoningChunk?.choices?.[0]?.delta?.content).toBeUndefined()

    const usageChunk = chunks.find((c) => c.usage)
    expect(usageChunk?.usage?.completion_tokens).toBe(2)
  })

  it('renders web search queries as backticked terms without prefixes', async () => {
    const searchQuery = 'best ramen near me'
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'tool', toolKind: 'webSearch', id: 'tool-search', status: 'started', title: searchQuery }
          yield { type: 'message', delta: 'working on it' }
          yield { type: 'tool', toolKind: 'webSearch', id: 'tool-search', status: 'completed', title: searchQuery }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 2 } }
        })(),
      }),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }
    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.1-codex',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    const response = await chatCompletionsHandler(request)
    const text = await response.text()
    const chunks = text
      .trim()
      .split('\n\n')
      .map((part) => part.replace(/^data: /, ''))
      .filter((part) => part !== '[DONE]')
      .map((part) => JSON.parse(part))

    const contentDeltas = chunks
      .map((c) => c.choices?.[0]?.delta?.content as string | undefined)
      .filter(Boolean) as string[]

    // Should emit the query once, wrapped in backticks, with nothing else attached.
    const searchContents = contentDeltas.filter((c) => c.includes(searchQuery))
    expect(searchContents).toHaveLength(1)
    expect(searchContents[0]).toBe(`\`${searchQuery}\``)
  })

  it('emits apply_patch diffs once inside a bash fence', async () => {
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield {
            type: 'tool',
            toolKind: 'file',
            id: 'file-1',
            status: 'started',
            title: 'file changes',
            data: {
              changes: [{ path: 'src/example.ts', diff: '@@\n- old\n+ new\n+ another\n+ third\n+ fourth\n+ fifth' }],
            },
          }
          yield {
            type: 'tool',
            toolKind: 'file',
            id: 'file-1',
            status: 'completed',
            title: 'file changes',
            detail: '1 change(s)',
            data: {
              changes: [{ path: 'src/example.ts', diff: '@@\n- old\n+ new\n+ another\n+ third\n+ fourth\n+ fifth' }],
            },
          }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
        })(),
      }),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }
    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.1-codex',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    const response = await chatCompletionsHandler(request)
    const text = await response.text()
    const chunks = text
      .trim()
      .split('\n\n')
      .map((part) => part.replace(/^data: /, ''))
      .filter((part) => part !== '[DONE]')
      .map((part) => JSON.parse(part))

    const contents = chunks.map((c) => c.choices?.[0]?.delta?.content as string | undefined).filter(Boolean) as string[]

    // Should output exactly one fenced diff, truncated to five lines plus an ellipsis.
    expect(contents).toEqual(['\n```bash\nsrc/example.ts\n@@\n- old\n+ new\n+ another\n+ third\n…\n```\n'])
  })

  it('streams a single command line once and leaves a blank line before output', async () => {
    const command = '/bin/bash -lc \'rg -n "jangar" packages | head\''
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'tool', toolKind: 'command', id: 'tool-1', status: 'started', title: command }
          yield {
            type: 'tool',
            toolKind: 'command',
            id: 'tool-1',
            status: 'delta',
            title: command,
            delta:
              'packages/cx-tools/README.md:7:Artifacts are expected to build into `dist/`\npackages/scripts/README.md:17:| `src/jangar/build-image.ts` | Builds and pushes the `lab/jangar` Bun worker image',
          }
          yield { type: 'tool', toolKind: 'command', id: 'tool-1', status: 'completed', title: command }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 2 } }
        })(),
      }),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }
    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.1-codex',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    const response = await chatCompletionsHandler(request)
    const text = await response.text()
    const chunks = text
      .trim()
      .split('\n\n')
      .map((part) => part.replace(/^data: /, ''))
      .filter((part) => part !== '[DONE]')
      .map((part) => JSON.parse(part))

    const contentChunks = chunks
      .map((c) => c.choices?.[0]?.delta?.content as string | undefined)
      .filter(Boolean) as string[]

    // Expect exactly: open fence, command line, output, close fence.
    expect(contentChunks.length).toBe(4)
    const [openFence, commandLine, outputChunk] = contentChunks

    expect(openFence.trim()).toBe('```')
    expect(commandLine).toContain(command)

    // Command string should not reappear inside output chunk, and output starts on its own line.
    expect(outputChunk.startsWith(command)).toBe(false)
    expect(outputChunk.includes(command)).toBe(false)

    // Only one appearance of the command line across all streamed content.
    const joinedContent = contentChunks.join('')
    const occurrences = joinedContent.split(command).length - 1
    expect(occurrences).toBe(1)
    expect(joinedContent.includes('\n---\n')).toBe(false)
  })

  it('inserts a separator before the second command but not for a single command', async () => {
    const commandA = 'bash -lc "echo first"'
    const commandB = 'bash -lc "echo second"'
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          // First command
          yield { type: 'tool', toolKind: 'command', id: 'cmd-1', status: 'started', title: commandA }
          yield {
            type: 'tool',
            toolKind: 'command',
            id: 'cmd-1',
            status: 'delta',
            title: commandA,
            delta: 'first output',
          }
          yield { type: 'tool', toolKind: 'command', id: 'cmd-1', status: 'completed', title: commandA }

          // Second command
          yield { type: 'tool', toolKind: 'command', id: 'cmd-2', status: 'started', title: commandB }
          yield {
            type: 'tool',
            toolKind: 'command',
            id: 'cmd-2',
            status: 'delta',
            title: commandB,
            delta: 'second output',
          }
          yield { type: 'tool', toolKind: 'command', id: 'cmd-2', status: 'completed', title: commandB }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 2 } }
        })(),
      }),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }
    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.1-codex',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    const response = await chatCompletionsHandler(request)
    const text = await response.text()
    const chunks = text
      .trim()
      .split('\n\n')
      .map((part) => part.replace(/^data: /, ''))
      .filter((part) => part !== '[DONE]')
      .map((part) => JSON.parse(part))

    const contentChunks = chunks
      .map((c) => c.choices?.[0]?.delta?.content as string | undefined)
      .filter(Boolean) as string[]

    const joined = contentChunks.join('\n')

    // First command should not include a separator before it
    const firstCommandIndex = joined.indexOf(commandA)
    expect(firstCommandIndex).toBeGreaterThanOrEqual(0)
    const precedingFirst = joined.slice(Math.max(0, firstCommandIndex - 10), firstCommandIndex)
    expect(precedingFirst.includes('---')).toBe(false)

    // Second command should have a separator immediately before its fence
    const secondCommandIndex = joined.indexOf(commandB)
    expect(secondCommandIndex).toBeGreaterThan(firstCommandIndex)
    const separatorSlice = joined.slice(Math.max(0, secondCommandIndex - 10), secondCommandIndex)
    expect(separatorSlice.includes('---')).toBe(true)
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
      body: JSON.stringify({
        model: 'gpt-5.1-codex',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
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
    const reasoningText = reasoningChunks.map((c) => c.choices[0].delta.reasoning_content as string).join('')
    expect(reasoningText).toBe('first second')
    // No content mixed into reasoning-only chunks
    expect(reasoningChunks.some((c) => c.choices?.[0]?.delta?.content)).toBe(false)
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
      body: JSON.stringify({
        model: 'gpt-5.1-codex',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    const response = await chatCompletionsHandler(request)
    const text = await response.text()
    const chunks = text
      .trim()
      .split('\n\n')
      .map((part) => part.replace(/^data: /, ''))
      .filter((part) => part !== '[DONE]')
      .map((part) => JSON.parse(part))

    const reasoningText = chunks
      .filter((c) => c.choices?.[0]?.delta?.reasoning_content)
      .map((c) => c.choices[0].delta.reasoning_content as string)
      .join('')
    expect(reasoningText).toBe('files\nPlanning')
    expect(
      chunks.filter((c) => c.choices?.[0]?.delta?.reasoning_content).some((c) => c.choices?.[0]?.delta?.content),
    ).toBe(false)
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
      body: JSON.stringify({
        model: 'gpt-5.1-codex',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    const response = await chatCompletionsHandler(request)
    const text = await response.text()
    const chunks = text
      .trim()
      .split('\n\n')
      .map((part) => part.replace(/^data: /, ''))
      .filter((part) => part !== '[DONE]')
      .map((part) => JSON.parse(part))

    const reasoningText = chunks
      .filter((c) => c.choices?.[0]?.delta?.reasoning_content)
      .map((c) => c.choices[0].delta.reasoning_content as string)
      .join('')
    expect(reasoningText).toBe('\nAfter')
    expect(
      chunks.filter((c) => c.choices?.[0]?.delta?.reasoning_content).some((c) => c.choices?.[0]?.delta?.content),
    ).toBe(false)
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
      body: JSON.stringify({
        model: 'gpt-5.1-codex',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
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

  it('omits usage unless include_usage is requested', async () => {
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'hello' }
          yield { type: 'usage', usage: { input_tokens: 2, output_tokens: 3 } }
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

    const usageChunk = chunks.find((c) => c.usage)
    expect(usageChunk).toBeUndefined()
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
      body: JSON.stringify({
        model: 'gpt-5.1-codex',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
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
