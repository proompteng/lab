import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CodexAppServerClient } from '@proompteng/codex'
import { Effect, pipe } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { chatCompletionsHandler } from '~/routes/openai/v1/chat/completions'
import { handleChatCompletionEffect, resetCodexClient, setCodexClientFactory } from '~/server/chat'
import { ChatCompletionEncoder, chatCompletionEncoderLive } from '~/server/chat-completion-encoder'
import { ChatToolEventRenderer, chatToolEventRendererLive } from '~/server/chat-tool-event-renderer'
import { buildTranscriptSignature, type TranscriptEntry } from '~/server/chat-transcript'
import { ThreadState, type ThreadStateService } from '~/server/thread-state'
import { TranscriptState, type TranscriptStateService } from '~/server/transcript-state'
import { WorktreeState, type WorktreeStateService } from '~/server/worktree-state'

describe('chat completions handler', () => {
  const previousEnv: Partial<
    Record<
      | 'JANGAR_MODELS'
      | 'JANGAR_DEFAULT_MODEL'
      | 'CODEX_CWD'
      | 'JANGAR_STATEFUL_CHAT_MODE'
      | 'JANGAR_CODEX_MAX_INPUT_CHARS',
      string | undefined
    >
  > = {}
  let worktreeRoot: string | null = null

  beforeEach(async () => {
    previousEnv.JANGAR_MODELS = process.env.JANGAR_MODELS
    previousEnv.JANGAR_DEFAULT_MODEL = process.env.JANGAR_DEFAULT_MODEL
    previousEnv.CODEX_CWD = process.env.CODEX_CWD
    previousEnv.JANGAR_STATEFUL_CHAT_MODE = process.env.JANGAR_STATEFUL_CHAT_MODE
    previousEnv.JANGAR_CODEX_MAX_INPUT_CHARS = process.env.JANGAR_CODEX_MAX_INPUT_CHARS
    delete process.env.JANGAR_MODELS
    delete process.env.JANGAR_DEFAULT_MODEL
    delete process.env.JANGAR_STATEFUL_CHAT_MODE
    delete process.env.JANGAR_CODEX_MAX_INPUT_CHARS

    worktreeRoot = await mkdtemp(join(tmpdir(), 'jangar-worktree-'))
    process.env.CODEX_CWD = worktreeRoot

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

  afterEach(async () => {
    vi.clearAllMocks()
    resetCodexClient()

    if (worktreeRoot) {
      await rm(worktreeRoot, { recursive: true, force: true })
      worktreeRoot = null
    }

    if (previousEnv.JANGAR_MODELS === undefined) {
      delete process.env.JANGAR_MODELS
    } else {
      process.env.JANGAR_MODELS = previousEnv.JANGAR_MODELS
    }

    if (previousEnv.JANGAR_DEFAULT_MODEL === undefined) {
      delete process.env.JANGAR_DEFAULT_MODEL
    } else {
      process.env.JANGAR_DEFAULT_MODEL = previousEnv.JANGAR_DEFAULT_MODEL
    }

    if (previousEnv.CODEX_CWD === undefined) {
      delete process.env.CODEX_CWD
    } else {
      process.env.CODEX_CWD = previousEnv.CODEX_CWD
    }

    if (previousEnv.JANGAR_STATEFUL_CHAT_MODE === undefined) {
      delete process.env.JANGAR_STATEFUL_CHAT_MODE
    } else {
      process.env.JANGAR_STATEFUL_CHAT_MODE = previousEnv.JANGAR_STATEFUL_CHAT_MODE
    }

    if (previousEnv.JANGAR_CODEX_MAX_INPUT_CHARS === undefined) {
      delete process.env.JANGAR_CODEX_MAX_INPUT_CHARS
    } else {
      process.env.JANGAR_CODEX_MAX_INPUT_CHARS = previousEnv.JANGAR_CODEX_MAX_INPUT_CHARS
    }
  })

  it('proxies upstream SSE stream', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
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

  it('creates and releases a dedicated codex client for each streamed request', async () => {
    const firstClient = {
      runTurnStream: vi.fn(async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'first reply' }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }
    const secondClient = {
      runTurnStream: vi.fn(async () => ({
        turnId: 'turn-2',
        threadId: 'thread-2',
        stream: (async function* () {
          yield { type: 'message', delta: 'second reply' }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }
    const clientFactory = vi
      .fn()
      .mockReturnValueOnce(firstClient as unknown as CodexAppServerClient)
      .mockReturnValueOnce(secondClient as unknown as CodexAppServerClient)

    setCodexClientFactory(clientFactory as unknown as (options?: { defaultModel?: string }) => CodexAppServerClient)

    const firstResponse = await chatCompletionsHandler(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'first' }],
          stream: true,
        }),
      }),
    )
    expect(await firstResponse.text()).toContain('first reply')

    const secondResponse = await chatCompletionsHandler(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'second' }],
          stream: true,
        }),
      }),
    )
    expect(await secondResponse.text()).toContain('second reply')

    expect(clientFactory).toHaveBeenCalledTimes(2)
    expect(firstClient.stop).toHaveBeenCalledTimes(1)
    expect(secondClient.stop).toHaveBeenCalledTimes(1)
  })

  it('does not start codex for requests that fail model validation', async () => {
    const mockClient = {
      runTurnStream: vi.fn(),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }
    const clientFactory = vi.fn(() => mockClient as unknown as CodexAppServerClient)
    setCodexClientFactory(clientFactory as unknown as (options?: { defaultModel?: string }) => CodexAppServerClient)

    const response = await chatCompletionsHandler(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          model: 'not-a-real-model',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      }),
    )

    expect(response.status).toBe(400)
    expect(clientFactory).not.toHaveBeenCalled()
    expect(mockClient.stop).not.toHaveBeenCalled()
  })

  it('returns a non-stream completion payload when stream is false', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    })

    const response = await chatCompletionsHandler(request)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const payload = (await response.json()) as {
      object?: string
      choices?: Array<{ message?: { content?: string } }>
    }
    expect(payload.object).toBe('chat.completion')
    expect(payload.choices?.[0]?.message?.content).toContain('hi there')
  })

  it('returns a non-stream completion payload when stream is omitted', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    const response = await chatCompletionsHandler(request)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const payload = (await response.json()) as {
      object?: string
      choices?: Array<{ message?: { content?: string } }>
    }
    expect(payload.object).toBe('chat.completion')
    expect(payload.choices?.[0]?.message?.content).toContain('hi there')
  })

  it('renders plan deltas as markdown todos by default', async () => {
    const mockClient = {
      runTurnStream: vi.fn(async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield {
            type: 'plan',
            explanation: null,
            plan: [
              { step: 'Audit current thread-store behavior', status: 'completed' },
              { step: 'Create tagged thread-store service', status: 'in_progress' },
              { step: 'Wire chat handler to service', status: 'pending' },
            ],
          }
          yield { type: 'message', delta: 'ok' }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })

    const response = await chatCompletionsHandler(request)
    const text = await response.text()

    const chunks = text
      .trim()
      .split('\n\n')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('data: '))
      .map((part) => part.replace(/^data: /, ''))
      .filter((part) => part !== '[DONE]')
      .map((part) => JSON.parse(part))

    const content = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.content as string | undefined)
      .filter(Boolean)
      .join('')

    expect(content).toContain('**Plan**')
    expect(content).toContain('- [x] Audit current thread-store behavior')
    expect(content).toContain('- [ ] Create tagged thread-store service (in progress)')
    expect(content).toContain('- [ ] Wire chat handler to service')
    expect(content).toContain('ok')
  })

  it('suppresses plan deltas when include_plan is false', async () => {
    const mockClient = {
      runTurnStream: vi.fn(async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield {
            type: 'plan',
            explanation: null,
            plan: [{ step: 'should not show', status: 'pending' }],
          }
          yield { type: 'message', delta: 'ok' }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_plan: false },
      }),
    })

    const response = await chatCompletionsHandler(request)
    const text = await response.text()

    const chunks = text
      .trim()
      .split('\n\n')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('data: '))
      .map((part) => part.replace(/^data: /, ''))
      .filter((part) => part !== '[DONE]')
      .map((part) => JSON.parse(part))

    const content = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.content as string | undefined)
      .filter(Boolean)
      .join('')

    expect(content).not.toContain('**Plan**')
    expect(content).not.toContain('should not show')
    expect(content).toContain('ok')
  })

  it('strips terminal escape codes from streamed content', async () => {
    const mockClient = {
      runTurnStream: vi.fn(async (_prompt: string) => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield {
            type: 'message',
            delta: '\u001b[32mgreen\u001b[0m and \u241b[31mred\u241b[0m',
          }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })

    const response = await chatCompletionsHandler(request)

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('\u241b')

    const chunks = text
      .split('\n\n')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('data: '))
      .map((part) => part.replace(/^data: /, ''))
      .filter((part) => part !== '[DONE]')
      .map((part) => JSON.parse(part))

    const content = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.content as string | undefined)
      .filter(Boolean)
      .join('')

    expect(content).toBe('\ngreen and red')
  })

  it('strips terminal escape codes from reasoning content', async () => {
    const mockClient = {
      runTurnStream: vi.fn(async (_prompt: string) => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'reasoning', delta: '\u001b[35mthinking\u001b[0m' }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })

    const response = await chatCompletionsHandler(request)

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('\u241b')

    const chunks = text
      .split('\n\n')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('data: '))
      .map((part) => part.replace(/^data: /, ''))
      .filter((part) => part !== '[DONE]')
      .map((part) => JSON.parse(part))

    const reasoningText = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content as string | undefined)
      .filter(Boolean)
      .join('')

    expect(reasoningText).toBe('thinking')
  })

  it('validates requested model against the advertised list', async () => {
    process.env.JANGAR_MODELS = 'allowed-model'
    process.env.JANGAR_DEFAULT_MODEL = 'allowed-model'

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        model: 'unknown-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })

    const response = await chatCompletionsHandler(request)

    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    expect(text.trim().endsWith('[DONE]')).toBe(true)
    const chunks = text
      .trim()
      .split('\n\n')
      .map((part) => part.replace(/^data: /, ''))
      .filter((part) => part !== '[DONE]')
      .map((part) => JSON.parse(part))
    const errorChunk = chunks.find((chunk) => chunk.error)
    expect(errorChunk?.error?.code).toBe('model_not_found')
  })

  it('builds prompts from OpenAI-style content parts', async () => {
    const mockClient = {
      runTurnStream: vi.fn(async (_prompt: string) => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'ok' }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hello' },
              { type: 'image_url', image_url: { url: 'https://example.test/cat.png' } },
            ],
          },
        ],
        stream: true,
      }),
    })

    const response = await chatCompletionsHandler(request)
    await response.text()

    expect(mockClient.runTurnStream).toHaveBeenCalled()
    const prompt = mockClient.runTurnStream.mock.calls[0]?.[0]
    expect(typeof prompt).toBe('string')
    expect(prompt).toContain('user: hello [image_url] https://example.test/cat.png')
  })

  it('interrupts turns even when the response stream is cancelled before ids are available', async () => {
    const mockClient = {
      runTurnStream: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        return {
          turnId: 'turn-1',
          threadId: 'thread-1',
          stream: (async function* () {
            // If we ever start streaming, keep it short.
            yield { type: 'message', delta: 'hello' }
          })(),
        }
      }),
      interruptTurn: vi.fn(async () => {}),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    const response = await chatCompletionsHandler(request)
    const reader = response.body?.getReader()

    expect(reader).toBeTruthy()
    await reader?.cancel('client disconnect')

    await vi.waitFor(() => {
      expect(mockClient.interruptTurn).toHaveBeenCalledWith('turn-1', 'thread-1')
    })
  })

  it('interrupts proxied non-stream turns when the request signal aborts', async () => {
    let releaseStream: (() => void) | null = null
    const mockClient = {
      runTurnStream: vi.fn(async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          await new Promise<void>((resolve) => {
            releaseStream = resolve
          })
        })(),
      })),
      interruptTurn: vi.fn(async () => {
        releaseStream?.()
      }),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const abortController = new AbortController()
    const responsePromise = chatCompletionsHandler(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
        signal: abortController.signal,
      }),
    )

    await vi.waitFor(() => {
      expect(mockClient.runTurnStream).toHaveBeenCalledTimes(1)
    })

    abortController.abort('client disconnect')

    const response = await Promise.race([
      responsePromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for aborted non-stream response')), 250)
      }),
    ])

    expect(response.status).toBe(200)
    await vi.waitFor(() => {
      expect(mockClient.interruptTurn).toHaveBeenCalledWith('turn-1', 'thread-1')
    })
  })

  it('retries on stale thread ids by clearing redis mapping', async () => {
    const threadState: ThreadStateService = {
      getThreadId: vi.fn(() => Effect.succeed('stale-thread')),
      setThreadId: vi.fn(() => Effect.succeed(undefined)),
      nextTurn: vi.fn(() => Effect.succeed(1)),
      clearChat: vi.fn(() => Effect.succeed(undefined)),
    }
    const worktreeState: WorktreeStateService = {
      getWorktreeName: vi.fn(() => Effect.succeed('austin')),
      setWorktreeName: vi.fn(() => Effect.succeed(undefined)),
      clearWorktree: vi.fn(() => Effect.succeed(undefined)),
    }
    const transcriptState: TranscriptStateService = {
      getTranscript: vi.fn(() => Effect.succeed(null)),
      setTranscript: vi.fn(() => Effect.succeed(undefined)),
      clearTranscript: vi.fn(() => Effect.succeed(undefined)),
    }

    const mockClient = {
      runTurnStream: vi.fn(async (_prompt: string, opts?: { threadId?: string }) => {
        if (opts?.threadId === 'stale-thread') {
          return {
            turnId: 'turn-1',
            threadId: 'stale-thread',
            stream: (async function* () {
              yield {
                type: 'error',
                error: { code: -32600, message: 'conversation not found: stale-thread' },
              }
            })(),
          }
        }

        return {
          turnId: 'turn-2',
          threadId: 'fresh-thread',
          stream: (async function* () {
            yield { type: 'message', delta: 'hello after retry' }
            yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
          })(),
        }
      }),
      interruptTurn: vi.fn(async () => {}),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-1',
        'x-jangar-client-kind': 'discord',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    const response = await Effect.runPromise(
      pipe(
        handleChatCompletionEffect(request),
        Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
        Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
        Effect.provideService(ThreadState, threadState),
        Effect.provideService(WorktreeState, worktreeState),
        Effect.provideService(TranscriptState, transcriptState),
      ),
    )
    const text = await response.text()

    expect(text).toContain('hello after retry')
    expect(mockClient.runTurnStream).toHaveBeenCalledTimes(2)
    expect(threadState.clearChat).toHaveBeenCalledWith('chat-1')
    expect(threadState.setThreadId).toHaveBeenLastCalledWith('chat-1', 'fresh-thread')
  })

  it('retries on stale thread ids when app-server rejects with thread not found', async () => {
    process.env.JANGAR_STATEFUL_CHAT_MODE = '1'

    const threadState: ThreadStateService = {
      getThreadId: vi.fn(() => Effect.succeed('stale-thread')),
      setThreadId: vi.fn(() => Effect.succeed(undefined)),
      nextTurn: vi.fn(() => Effect.succeed(1)),
      clearChat: vi.fn(() => Effect.succeed(undefined)),
    }
    const worktreeState: WorktreeStateService = {
      getWorktreeName: vi.fn(() => Effect.succeed('austin')),
      setWorktreeName: vi.fn(() => Effect.succeed(undefined)),
      clearWorktree: vi.fn(() => Effect.succeed(undefined)),
    }
    const transcriptState: TranscriptStateService = {
      getTranscript: vi.fn(() => Effect.succeed(buildTranscriptSignature([{ role: 'user', content: 'hi' }]))),
      setTranscript: vi.fn(() => Effect.succeed(undefined)),
      clearTranscript: vi.fn(() => Effect.succeed(undefined)),
    }

    const mockClient = {
      runTurnStream: vi.fn(async (_prompt: string, opts?: { threadId?: string }) => {
        if (opts?.threadId === 'stale-thread') {
          throw { code: -32600, message: 'thread not found: stale-thread' }
        }

        return {
          turnId: 'turn-2',
          threadId: 'fresh-thread',
          stream: (async function* () {
            yield { type: 'message', delta: 'hello after retry' }
            yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
          })(),
        }
      }),
      interruptTurn: vi.fn(async () => {}),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-1',
        'x-jangar-client-kind': 'discord',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })

    const response = await Effect.runPromise(
      pipe(
        handleChatCompletionEffect(request),
        Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
        Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
        Effect.provideService(ThreadState, threadState),
        Effect.provideService(WorktreeState, worktreeState),
        Effect.provideService(TranscriptState, transcriptState),
      ),
    )
    const text = await response.text()

    expect(text).toContain('hello after retry')
    expect(mockClient.runTurnStream).toHaveBeenCalledTimes(2)
    expect(threadState.clearChat).toHaveBeenCalledWith('chat-1')
    expect(threadState.setThreadId).toHaveBeenLastCalledWith('chat-1', 'fresh-thread')
  })

  it('resets a stored thread when the transcript signature is missing', async () => {
    process.env.JANGAR_STATEFUL_CHAT_MODE = '1'

    const threadState: ThreadStateService = {
      getThreadId: vi.fn(() => Effect.succeed('thread-1')),
      setThreadId: vi.fn(() => Effect.succeed(undefined)),
      nextTurn: vi.fn(() => Effect.succeed(1)),
      clearChat: vi.fn(() => Effect.succeed(undefined)),
    }
    const worktreeState: WorktreeStateService = {
      getWorktreeName: vi.fn(() => Effect.succeed('austin')),
      setWorktreeName: vi.fn(() => Effect.succeed(undefined)),
      clearWorktree: vi.fn(() => Effect.succeed(undefined)),
    }
    const transcriptState: TranscriptStateService = {
      getTranscript: vi.fn(() => Effect.succeed(null)),
      setTranscript: vi.fn(() => Effect.succeed(undefined)),
      clearTranscript: vi.fn(() => Effect.succeed(undefined)),
    }

    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi!' },
      { role: 'user', content: 'follow up' },
    ]

    const mockClient = {
      runTurnStream: vi.fn(async (_prompt: string, _opts?: { threadId?: string }) => ({
        turnId: 'turn-2',
        threadId: 'fresh-thread',
        stream: (async function* () {
          yield { type: 'message', delta: 'ok' }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-1',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages,
        stream: true,
      }),
    })

    const response = await Effect.runPromise(
      pipe(
        handleChatCompletionEffect(request),
        Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
        Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
        Effect.provideService(ThreadState, threadState),
        Effect.provideService(WorktreeState, worktreeState),
        Effect.provideService(TranscriptState, transcriptState),
      ),
    )
    await response.text()

    expect(threadState.clearChat).toHaveBeenCalledWith('chat-1')
    expect(transcriptState.clearTranscript).not.toHaveBeenCalled()
    const opts = mockClient.runTurnStream.mock.calls[0]?.[1] as { threadId?: string } | undefined
    expect(opts?.threadId).toBeUndefined()
    const prompt = mockClient.runTurnStream.mock.calls[0]?.[0]
    expect(prompt).toContain('system: You are helpful.')
    expect(prompt).toContain('user: hello')
    expect(prompt).toContain('assistant: hi!')
    expect(prompt).toContain('user: follow up')
    expect(threadState.setThreadId).toHaveBeenLastCalledWith('chat-1', 'fresh-thread')
  })

  it('sends only new messages when OpenWebUI transcript is append-only', async () => {
    process.env.JANGAR_STATEFUL_CHAT_MODE = '1'

    const threadState: ThreadStateService = {
      getThreadId: vi.fn(() => Effect.succeed('thread-1')),
      setThreadId: vi.fn(() => Effect.succeed(undefined)),
      nextTurn: vi.fn(() => Effect.succeed(1)),
      clearChat: vi.fn(() => Effect.succeed(undefined)),
    }
    const worktreeState: WorktreeStateService = {
      getWorktreeName: vi.fn(() => Effect.succeed('austin')),
      setWorktreeName: vi.fn(() => Effect.succeed(undefined)),
      clearWorktree: vi.fn(() => Effect.succeed(undefined)),
    }

    const initialMessages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi!' },
    ]
    const transcriptState: TranscriptStateService = {
      getTranscript: vi.fn(() => Effect.succeed(buildTranscriptSignature(initialMessages))),
      setTranscript: vi.fn(() => Effect.succeed(undefined)),
      clearTranscript: vi.fn(() => Effect.succeed(undefined)),
    }

    const mockClient = {
      runTurnStream: vi.fn(async (_prompt: string) => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'ok' }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-1',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [...initialMessages, { role: 'user', content: 'follow up' }],
        stream: true,
      }),
    })

    const response = await Effect.runPromise(
      pipe(
        handleChatCompletionEffect(request),
        Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
        Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
        Effect.provideService(ThreadState, threadState),
        Effect.provideService(WorktreeState, worktreeState),
        Effect.provideService(TranscriptState, transcriptState),
      ),
    )
    await response.text()

    const prompt = mockClient.runTurnStream.mock.calls[0]?.[0]
    expect(prompt).toBe('user: follow up')
    expect(transcriptState.setTranscript).toHaveBeenCalled()
  })

  it('defaults OpenWebUI transcript handling to additive mode', async () => {
    const threadState: ThreadStateService = {
      getThreadId: vi.fn(() => Effect.succeed('thread-1')),
      setThreadId: vi.fn(() => Effect.succeed(undefined)),
      nextTurn: vi.fn(() => Effect.succeed(1)),
      clearChat: vi.fn(() => Effect.succeed(undefined)),
    }
    const worktreeState: WorktreeStateService = {
      getWorktreeName: vi.fn(() => Effect.succeed('austin')),
      setWorktreeName: vi.fn(() => Effect.succeed(undefined)),
      clearWorktree: vi.fn(() => Effect.succeed(undefined)),
    }

    const initialMessages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi!' },
    ]
    const transcriptState: TranscriptStateService = {
      getTranscript: vi.fn(() => Effect.succeed(buildTranscriptSignature(initialMessages))),
      setTranscript: vi.fn(() => Effect.succeed(undefined)),
      clearTranscript: vi.fn(() => Effect.succeed(undefined)),
    }

    const mockClient = {
      runTurnStream: vi.fn(async (_prompt: string) => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'ok' }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-1',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [...initialMessages, { role: 'user', content: 'follow up' }],
        stream: true,
      }),
    })

    const response = await Effect.runPromise(
      pipe(
        handleChatCompletionEffect(request),
        Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
        Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
        Effect.provideService(ThreadState, threadState),
        Effect.provideService(WorktreeState, worktreeState),
        Effect.provideService(TranscriptState, transcriptState),
      ),
    )
    await response.text()

    const prompt = mockClient.runTurnStream.mock.calls[0]?.[0]
    expect(prompt).toBe('user: follow up')
  })

  it('keeps OpenWebUI thread and worktree state when additive transcript mode is disabled', async () => {
    process.env.JANGAR_STATEFUL_CHAT_MODE = '0'

    const threadState: ThreadStateService = {
      getThreadId: vi.fn(() => Effect.succeed('thread-1')),
      setThreadId: vi.fn(() => Effect.succeed(undefined)),
      nextTurn: vi.fn(() => Effect.succeed(1)),
      clearChat: vi.fn(() => Effect.succeed(undefined)),
    }
    const worktreeState: WorktreeStateService = {
      getWorktreeName: vi.fn(() => Effect.succeed('austin')),
      setWorktreeName: vi.fn(() => Effect.succeed(undefined)),
      clearWorktree: vi.fn(() => Effect.succeed(undefined)),
    }
    const transcriptState: TranscriptStateService = {
      getTranscript: vi.fn(() => Effect.succeed(null)),
      setTranscript: vi.fn(() => Effect.succeed(undefined)),
      clearTranscript: vi.fn(() => Effect.succeed(undefined)),
    }

    const mockClient = {
      runTurnStream: vi.fn(async (_prompt: string, _opts?: { threadId?: string; cwd?: string }) => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'ok' }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-1',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi!' },
          { role: 'user', content: 'follow up' },
        ],
        stream: true,
      }),
    })

    const response = await Effect.runPromise(
      pipe(
        handleChatCompletionEffect(request),
        Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
        Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
        Effect.provideService(ThreadState, threadState),
        Effect.provideService(WorktreeState, worktreeState),
        Effect.provideService(TranscriptState, transcriptState),
      ),
    )
    await response.text()

    expect(threadState.getThreadId).toHaveBeenCalledWith('chat-1')
    expect(worktreeState.getWorktreeName).toHaveBeenCalledWith('chat-1')
    expect(threadState.clearChat).not.toHaveBeenCalled()
    expect(transcriptState.getTranscript).not.toHaveBeenCalled()
    expect(transcriptState.setTranscript).not.toHaveBeenCalled()
    const opts = mockClient.runTurnStream.mock.calls[0]?.[1] as { threadId?: string; cwd?: string } | undefined
    expect(opts?.threadId).toBe('thread-1')
    expect(opts?.cwd).toContain('/.worktrees/austin')
  })

  it('persists assistant output so the next OpenWebUI turn stays additive', async () => {
    process.env.JANGAR_STATEFUL_CHAT_MODE = '1'

    let storedThreadId: string | null = null
    const threadState: ThreadStateService = {
      getThreadId: vi.fn(() => Effect.succeed(storedThreadId)),
      setThreadId: vi.fn((_, threadId) =>
        Effect.sync(() => {
          storedThreadId = threadId
        }),
      ),
      nextTurn: vi.fn(() => Effect.succeed(1)),
      clearChat: vi.fn(() => Effect.succeed(undefined)),
    }
    const worktreeState: WorktreeStateService = {
      getWorktreeName: vi.fn(() => Effect.succeed('austin')),
      setWorktreeName: vi.fn(() => Effect.succeed(undefined)),
      clearWorktree: vi.fn(() => Effect.succeed(undefined)),
    }

    let storedTranscript: TranscriptEntry[] | null = null
    const transcriptState: TranscriptStateService = {
      getTranscript: vi.fn(() => Effect.succeed(storedTranscript)),
      setTranscript: vi.fn((_, signature) =>
        Effect.sync(() => {
          storedTranscript = signature
        }),
      ),
      clearTranscript: vi.fn(() => Effect.succeed(undefined)),
    }

    let replyIndex = 0
    const assistantReplies = ['hi!', 'absolutely']
    const mockClient = {
      runTurnStream: vi.fn(async (_prompt: string, _opts?: { threadId?: string }) => {
        const reply = assistantReplies[replyIndex] ?? 'ok'
        replyIndex += 1
        return {
          turnId: `turn-${replyIndex}`,
          threadId: 'thread-1',
          stream: (async function* () {
            yield { type: 'message', delta: reply }
            yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
          })(),
        }
      }),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const firstRequest = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-1',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    })

    const firstResponse = await Effect.runPromise(
      pipe(
        handleChatCompletionEffect(firstRequest),
        Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
        Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
        Effect.provideService(ThreadState, threadState),
        Effect.provideService(WorktreeState, worktreeState),
        Effect.provideService(TranscriptState, transcriptState),
      ),
    )
    await firstResponse.text()

    expect(storedTranscript).toEqual(
      buildTranscriptSignature([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi!' },
      ]),
    )

    const secondRequest = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-1',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi!' },
          { role: 'user', content: 'follow up' },
        ],
        stream: true,
      }),
    })

    const secondResponse = await Effect.runPromise(
      pipe(
        handleChatCompletionEffect(secondRequest),
        Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
        Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
        Effect.provideService(ThreadState, threadState),
        Effect.provideService(WorktreeState, worktreeState),
        Effect.provideService(TranscriptState, transcriptState),
      ),
    )
    await secondResponse.text()

    const secondPrompt = mockClient.runTurnStream.mock.calls[1]?.[0]
    expect(secondPrompt).toBe('user: follow up')
  })

  it('retries stale OpenWebUI threads with the full transcript when rebuilding a thread', async () => {
    process.env.JANGAR_STATEFUL_CHAT_MODE = '1'

    const existingMessages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi!' },
    ]
    const requestMessages = [...existingMessages, { role: 'user', content: 'follow up' }]

    const threadState: ThreadStateService = {
      getThreadId: vi.fn(() => Effect.succeed('stale-thread')),
      setThreadId: vi.fn(() => Effect.succeed(undefined)),
      nextTurn: vi.fn(() => Effect.succeed(1)),
      clearChat: vi.fn(() => Effect.succeed(undefined)),
    }
    const worktreeState: WorktreeStateService = {
      getWorktreeName: vi.fn(() => Effect.succeed('austin')),
      setWorktreeName: vi.fn(() => Effect.succeed(undefined)),
      clearWorktree: vi.fn(() => Effect.succeed(undefined)),
    }
    const transcriptState: TranscriptStateService = {
      getTranscript: vi.fn(() => Effect.succeed(buildTranscriptSignature(existingMessages))),
      setTranscript: vi.fn(() => Effect.succeed(undefined)),
      clearTranscript: vi.fn(() => Effect.succeed(undefined)),
    }

    const mockClient = {
      runTurnStream: vi.fn(async (prompt: string, opts?: { threadId?: string }) => {
        if (opts?.threadId === 'stale-thread') {
          expect(prompt).toBe('user: follow up')
          return {
            turnId: 'turn-1',
            threadId: 'stale-thread',
            stream: (async function* () {
              yield {
                type: 'error',
                error: { code: -32600, message: 'conversation not found: stale-thread' },
              }
            })(),
          }
        }

        return {
          turnId: 'turn-2',
          threadId: 'fresh-thread',
          stream: (async function* () {
            yield { type: 'message', delta: 'hello after retry' }
            yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
          })(),
        }
      }),
      interruptTurn: vi.fn(async () => {}),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-1',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: requestMessages,
        stream: true,
      }),
    })

    const response = await Effect.runPromise(
      pipe(
        handleChatCompletionEffect(request),
        Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
        Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
        Effect.provideService(ThreadState, threadState),
        Effect.provideService(WorktreeState, worktreeState),
        Effect.provideService(TranscriptState, transcriptState),
      ),
    )
    await response.text()

    expect(mockClient.runTurnStream).toHaveBeenCalledTimes(2)
    const retryPrompt = mockClient.runTurnStream.mock.calls[1]?.[0]
    expect(retryPrompt).toBe('user: hello\nassistant: hi!\nuser: follow up')
  })

  it('trims oversized OpenWebUI retry prompts to the newest messages when rebuilding a thread', async () => {
    process.env.JANGAR_STATEFUL_CHAT_MODE = '1'
    process.env.JANGAR_CODEX_MAX_INPUT_CHARS = '80'

    const existingMessages = [
      { role: 'user', content: 'first context that should be dropped' },
      { role: 'assistant', content: 'second context that should still fit' },
    ]
    const requestMessages = [...existingMessages, { role: 'user', content: 'follow up' }]

    const threadState: ThreadStateService = {
      getThreadId: vi.fn(() => Effect.succeed('stale-thread')),
      setThreadId: vi.fn(() => Effect.succeed(undefined)),
      nextTurn: vi.fn(() => Effect.succeed(1)),
      clearChat: vi.fn(() => Effect.succeed(undefined)),
    }
    const worktreeState: WorktreeStateService = {
      getWorktreeName: vi.fn(() => Effect.succeed('austin')),
      setWorktreeName: vi.fn(() => Effect.succeed(undefined)),
      clearWorktree: vi.fn(() => Effect.succeed(undefined)),
    }
    const transcriptState: TranscriptStateService = {
      getTranscript: vi.fn(() => Effect.succeed(buildTranscriptSignature(existingMessages))),
      setTranscript: vi.fn(() => Effect.succeed(undefined)),
      clearTranscript: vi.fn(() => Effect.succeed(undefined)),
    }

    const mockClient = {
      runTurnStream: vi.fn(async (prompt: string, opts?: { threadId?: string }) => {
        if (opts?.threadId === 'stale-thread') {
          expect(prompt).toBe('user: follow up')
          return {
            turnId: 'turn-1',
            threadId: 'stale-thread',
            stream: (async function* () {
              yield {
                type: 'error',
                error: { code: -32600, message: 'conversation not found: stale-thread' },
              }
            })(),
          }
        }

        return {
          turnId: 'turn-2',
          threadId: 'fresh-thread',
          stream: (async function* () {
            yield { type: 'message', delta: 'hello after retry' }
            yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
          })(),
        }
      }),
      interruptTurn: vi.fn(async () => {}),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-1',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: requestMessages,
        stream: true,
      }),
    })

    const response = await Effect.runPromise(
      pipe(
        handleChatCompletionEffect(request),
        Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
        Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
        Effect.provideService(ThreadState, threadState),
        Effect.provideService(WorktreeState, worktreeState),
        Effect.provideService(TranscriptState, transcriptState),
      ),
    )
    await response.text()

    expect(mockClient.runTurnStream).toHaveBeenCalledTimes(2)
    const retryPrompt = mockClient.runTurnStream.mock.calls[1]?.[0]
    expect(typeof retryPrompt).toBe('string')
    expect(retryPrompt.length).toBeLessThanOrEqual(80)
    expect(retryPrompt).not.toContain('first context that should be dropped')
    expect(retryPrompt).toContain('second context that should still fit')
    expect(retryPrompt).toContain('user: follow up')
  })

  it('resets the thread when OpenWebUI transcript is edited', async () => {
    process.env.JANGAR_STATEFUL_CHAT_MODE = '1'

    const threadState: ThreadStateService = {
      getThreadId: vi.fn(() => Effect.succeed('thread-1')),
      setThreadId: vi.fn(() => Effect.succeed(undefined)),
      nextTurn: vi.fn(() => Effect.succeed(1)),
      clearChat: vi.fn(() => Effect.succeed(undefined)),
    }
    const worktreeState: WorktreeStateService = {
      getWorktreeName: vi.fn(() => Effect.succeed('austin')),
      setWorktreeName: vi.fn(() => Effect.succeed(undefined)),
      clearWorktree: vi.fn(() => Effect.succeed(undefined)),
    }
    const storedMessages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
    ]
    const transcriptState: TranscriptStateService = {
      getTranscript: vi.fn(() => Effect.succeed(buildTranscriptSignature(storedMessages))),
      setTranscript: vi.fn(() => Effect.succeed(undefined)),
      clearTranscript: vi.fn(() => Effect.succeed(undefined)),
    }

    const mockClient = {
      runTurnStream: vi.fn(async (_prompt: string, _opts?: { threadId?: string }) => ({
        turnId: 'turn-1',
        threadId: 'thread-2',
        stream: (async function* () {
          yield { type: 'message', delta: 'ok' }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-1',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [
          { role: 'system', content: 'You are *very* helpful.' },
          { role: 'user', content: 'hello' },
          { role: 'user', content: 'second message' },
        ],
        stream: true,
      }),
    })

    const response = await Effect.runPromise(
      pipe(
        handleChatCompletionEffect(request),
        Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
        Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
        Effect.provideService(ThreadState, threadState),
        Effect.provideService(WorktreeState, worktreeState),
        Effect.provideService(TranscriptState, transcriptState),
      ),
    )
    await response.text()

    expect(threadState.clearChat).toHaveBeenCalledWith('chat-1')
    const opts = mockClient.runTurnStream.mock.calls[0]?.[1] as { threadId?: string } | undefined
    expect(opts?.threadId).toBeUndefined()
    const prompt = mockClient.runTurnStream.mock.calls[0]?.[0]
    expect(prompt).toContain('system: You are *very* helpful.')
    expect(prompt).toContain('user: hello')
    expect(prompt).toContain('user: second message')
  })

  it('keeps thread state for discord clients even when transcript differs', async () => {
    process.env.JANGAR_STATEFUL_CHAT_MODE = '1'

    const threadState: ThreadStateService = {
      getThreadId: vi.fn(() => Effect.succeed('thread-1')),
      setThreadId: vi.fn(() => Effect.succeed(undefined)),
      nextTurn: vi.fn(() => Effect.succeed(1)),
      clearChat: vi.fn(() => Effect.succeed(undefined)),
    }
    const worktreeState: WorktreeStateService = {
      getWorktreeName: vi.fn(() => Effect.succeed('austin')),
      setWorktreeName: vi.fn(() => Effect.succeed(undefined)),
      clearWorktree: vi.fn(() => Effect.succeed(undefined)),
    }
    const storedMessages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
    ]
    const transcriptState: TranscriptStateService = {
      getTranscript: vi.fn(() => Effect.succeed(buildTranscriptSignature(storedMessages))),
      setTranscript: vi.fn(() => Effect.succeed(undefined)),
      clearTranscript: vi.fn(() => Effect.succeed(undefined)),
    }

    const mockClient = {
      runTurnStream: vi.fn(async (_prompt: string, _opts?: { threadId?: string }) => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'ok' }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-1',
        'x-jangar-client-kind': 'discord',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [
          { role: 'system', content: 'You are *very* helpful.' },
          { role: 'user', content: 'hello' },
          { role: 'user', content: 'follow up' },
        ],
        stream: true,
      }),
    })

    const response = await Effect.runPromise(
      pipe(
        handleChatCompletionEffect(request),
        Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
        Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
        Effect.provideService(ThreadState, threadState),
        Effect.provideService(WorktreeState, worktreeState),
        Effect.provideService(TranscriptState, transcriptState),
      ),
    )
    await response.text()

    expect(threadState.clearChat).not.toHaveBeenCalled()
    expect(transcriptState.getTranscript).not.toHaveBeenCalled()
    expect(transcriptState.setTranscript).not.toHaveBeenCalled()
    const opts = mockClient.runTurnStream.mock.calls[0]?.[1] as { threadId?: string } | undefined
    expect(opts?.threadId).toBe('thread-1')
  })

  it('treats explicit internal clients as stateless even with openwebui chat IDs', async () => {
    process.env.JANGAR_STATEFUL_CHAT_MODE = '1'

    const threadState: ThreadStateService = {
      getThreadId: vi.fn(() => Effect.succeed('thread-1')),
      setThreadId: vi.fn(() => Effect.succeed(undefined)),
      nextTurn: vi.fn(() => Effect.succeed(1)),
      clearChat: vi.fn(() => Effect.succeed(undefined)),
    }
    const worktreeState: WorktreeStateService = {
      getWorktreeName: vi.fn(() => Effect.succeed('austin')),
      setWorktreeName: vi.fn(() => Effect.succeed(undefined)),
      clearWorktree: vi.fn(() => Effect.succeed(undefined)),
    }
    const transcriptState: TranscriptStateService = {
      getTranscript: vi.fn(() => Effect.succeed(null)),
      setTranscript: vi.fn(() => Effect.succeed(undefined)),
      clearTranscript: vi.fn(() => Effect.succeed(undefined)),
    }

    const mockClient = {
      runTurnStream: vi.fn(async (_prompt: string, _opts?: { threadId?: string }) => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'ok' }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-internal',
        'x-jangar-client-kind': 'internal',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'do something' }],
        stream: true,
      }),
    })

    const response = await Effect.runPromise(
      pipe(
        handleChatCompletionEffect(request),
        Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
        Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
        Effect.provideService(ThreadState, threadState),
        Effect.provideService(WorktreeState, worktreeState),
        Effect.provideService(TranscriptState, transcriptState),
      ),
    )

    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).toContain('ok')
    expect(threadState.getThreadId).not.toHaveBeenCalled()
    expect(worktreeState.getWorktreeName).not.toHaveBeenCalled()
    expect(transcriptState.getTranscript).not.toHaveBeenCalled()
  })

  it('returns a clean SSE error when the latest message alone exceeds the upstream input cap', async () => {
    process.env.JANGAR_CODEX_MAX_INPUT_CHARS = '20'

    const mockClient = {
      runTurnStream: vi.fn(),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }
    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const response = await chatCompletionsHandler(
      new Request('http://localhost', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-openwebui-chat-id': 'chat-1',
        },
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'x'.repeat(40) }],
          stream: true,
        }),
      }),
    )

    expect(response.status).toBe(400)
    expect(mockClient.runTurnStream).not.toHaveBeenCalled()

    const text = await response.text()
    expect(text).toContain('input_too_large')
    expect(text).toContain('Start a new chat or shorten the latest message.')
  })

  it('runs trade-execution requests statelessly in a dedicated torghut workspace', async () => {
    process.env.JANGAR_STATEFUL_CHAT_MODE = '1'
    process.env.JANGAR_MODELS = 'gpt-5.4'

    const threadState: ThreadStateService = {
      getThreadId: vi.fn(() => Effect.succeed('thread-1')),
      setThreadId: vi.fn(() => Effect.succeed(undefined)),
      nextTurn: vi.fn(() => Effect.succeed(1)),
      clearChat: vi.fn(() => Effect.succeed(undefined)),
    }
    const worktreeState: WorktreeStateService = {
      getWorktreeName: vi.fn(() => Effect.succeed('austin')),
      setWorktreeName: vi.fn(() => Effect.succeed(undefined)),
      clearWorktree: vi.fn(() => Effect.succeed(undefined)),
    }
    const transcriptState: TranscriptStateService = {
      getTranscript: vi.fn(() => Effect.succeed(null)),
      setTranscript: vi.fn(() => Effect.succeed(undefined)),
      clearTranscript: vi.fn(() => Effect.succeed(undefined)),
    }

    const mockClient = {
      runTurnStream: vi.fn(async (_prompt: string, _opts?: { threadId?: string; model?: string; cwd?: string }) => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'ok' }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-1',
        'x-trade-execution': 'torghut',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'execute trade intent' }],
        stream: true,
      }),
    })

    const response = await Effect.runPromise(
      pipe(
        handleChatCompletionEffect(request),
        Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
        Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
        Effect.provideService(ThreadState, threadState),
        Effect.provideService(WorktreeState, worktreeState),
        Effect.provideService(TranscriptState, transcriptState),
      ),
    )
    await response.text()

    expect(threadState.getThreadId).not.toHaveBeenCalled()
    expect(worktreeState.getWorktreeName).not.toHaveBeenCalled()
    expect(transcriptState.getTranscript).not.toHaveBeenCalled()

    const opts = mockClient.runTurnStream.mock.calls[0]?.[1] as
      | { threadId?: string; model?: string; cwd?: string }
      | undefined
    expect(opts?.threadId).toBeUndefined()
    expect(opts?.model).toBe('gpt-5.4')
    if (!worktreeRoot) throw new Error('expected temporary CODEX_CWD to be set')
    const expectedCwd = join(worktreeRoot, 'torghut')
    expect(opts?.cwd).toBe(expectedCwd)
    const cwdStat = await stat(expectedCwd)
    expect(cwdStat.isDirectory()).toBe(true)
  })

  it('returns 400 when x-trade-execution has an invalid value', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-trade-execution': 'not-torghut',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'execute trade intent' }],
        stream: true,
      }),
    })

    const response = await chatCompletionsHandler(request)
    expect(response.status).toBe(400)

    const text = await response.text()
    expect(text).toContain('invalid_trade_execution_header')
    expect(text).toContain('[DONE]')
  })

  it('returns 400 when legacy x-jangar-client-kind trade-execution header is used', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-jangar-client-kind': 'trade-execution',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'execute trade intent' }],
        stream: true,
      }),
    })

    const response = await chatCompletionsHandler(request)
    expect(response.status).toBe(400)

    const text = await response.text()
    expect(text).toContain('deprecated_trade_execution_header')
    expect(text).toContain('[DONE]')
  })

  it('requires an explicit model for x-trade-execution requests', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-trade-execution': 'torghut',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'execute trade intent' }],
        stream: true,
      }),
    })

    const response = await chatCompletionsHandler(request)
    expect(response.status).toBe(400)

    const text = await response.text()
    expect(text).toContain('model_required')
    expect(text).toContain('[DONE]')
  })

  it('falls back to stateless behavior when Redis state is unavailable', async () => {
    process.env.JANGAR_STATEFUL_CHAT_MODE = '1'

    const threadState: ThreadStateService = {
      getThreadId: vi.fn(() => Effect.fail(new Error('redis down'))),
      setThreadId: vi.fn(() => Effect.succeed(undefined)),
      nextTurn: vi.fn(() => Effect.succeed(1)),
      clearChat: vi.fn(() => Effect.succeed(undefined)),
    }
    const worktreeState: WorktreeStateService = {
      getWorktreeName: vi.fn(() => Effect.succeed('austin')),
      setWorktreeName: vi.fn(() => Effect.succeed(undefined)),
      clearWorktree: vi.fn(() => Effect.succeed(undefined)),
    }
    const transcriptState: TranscriptStateService = {
      getTranscript: vi.fn(() => Effect.succeed(null)),
      setTranscript: vi.fn(() => Effect.succeed(undefined)),
      clearTranscript: vi.fn(() => Effect.succeed(undefined)),
    }

    const mockClient = {
      runTurnStream: vi.fn(async (_prompt: string, _opts?: { threadId?: string }) => ({
        turnId: 'turn-1',
        threadId: 'thread-2',
        stream: (async function* () {
          yield { type: 'message', delta: 'ok' }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } }
        })(),
      })),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }

    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-1',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
          { role: 'user', content: 'follow up' },
        ],
        stream: true,
      }),
    })

    const response = await Effect.runPromise(
      pipe(
        handleChatCompletionEffect(request),
        Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
        Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
        Effect.provideService(ThreadState, threadState),
        Effect.provideService(WorktreeState, worktreeState),
        Effect.provideService(TranscriptState, transcriptState),
      ),
    )
    await response.text()

    expect(worktreeState.getWorktreeName).not.toHaveBeenCalled()
    const opts = mockClient.runTurnStream.mock.calls[0]?.[1] as { threadId?: string } | undefined
    expect(opts?.threadId).toBeUndefined()
    const prompt = mockClient.runTurnStream.mock.calls[0]?.[0]
    expect(prompt).toContain('user: hello')
    expect(prompt).toContain('assistant: hi')
    expect(prompt).toContain('user: follow up')
  })

  it('does not install dependencies when allocating a new worktree', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'

    const threadState: ThreadStateService = {
      getThreadId: vi.fn(() => Effect.succeed(null)),
      setThreadId: vi.fn(() => Effect.succeed(undefined)),
      nextTurn: vi.fn(() => Effect.succeed(1)),
      clearChat: vi.fn(() => Effect.succeed(undefined)),
    }
    const worktreeState: WorktreeStateService = {
      getWorktreeName: vi.fn(() => Effect.succeed(null)),
      setWorktreeName: vi.fn(() => Effect.succeed(undefined)),
      clearWorktree: vi.fn(() => Effect.succeed(undefined)),
    }
    const transcriptState: TranscriptStateService = {
      getTranscript: vi.fn(() => Effect.succeed(null)),
      setTranscript: vi.fn(() => Effect.succeed(undefined)),
      clearTranscript: vi.fn(() => Effect.succeed(undefined)),
    }

    const originalBun = (globalThis as { Bun?: unknown }).Bun
    const spawnImpl = vi.fn((args: string[] | string, options?: { cwd?: string }) => {
      const command = Array.isArray(args) ? args : [args]
      const exitCode = command[0] === 'git' && command[1] === 'show-ref' ? 1 : 0
      const stream = new ReadableStream({
        start(controller) {
          controller.close()
        },
      })

      return {
        exited: Promise.resolve(exitCode),
        stdout: stream,
        stderr: stream,
        ...options,
      }
    })
    let spawnSpy: { mock: { calls: unknown[][] } } & { mockRestore?: () => void }
    let shouldDeleteBun = false

    if (originalBun && typeof (originalBun as { spawn?: unknown }).spawn === 'function') {
      const bunForSpy = originalBun as { spawn: (...args: unknown[]) => unknown }
      spawnSpy = vi.spyOn(bunForSpy, 'spawn').mockImplementation(spawnImpl as (...args: unknown[]) => unknown)
    } else {
      Object.defineProperty(globalThis, 'Bun', {
        value: { spawn: spawnImpl },
        configurable: true,
      })
      spawnSpy = spawnImpl
      shouldDeleteBun = true
    }

    const request = new Request('http://localhost', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openwebui-chat-id': 'chat-2',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })

    try {
      const response = await Effect.runPromise(
        pipe(
          handleChatCompletionEffect(request),
          Effect.provideService(ChatToolEventRenderer, chatToolEventRendererLive),
          Effect.provideService(ChatCompletionEncoder, chatCompletionEncoderLive),
          Effect.provideService(ThreadState, threadState),
          Effect.provideService(WorktreeState, worktreeState),
          Effect.provideService(TranscriptState, transcriptState),
        ),
      )
      await response.text()
    } finally {
      const bunCalls = spawnSpy.mock.calls.filter((call) => Array.isArray(call[0]) && call[0][0] === 'bun')
      expect(bunCalls).toHaveLength(0)

      spawnSpy.mockRestore?.()
      if (shouldDeleteBun) {
        delete (globalThis as { Bun?: unknown }).Bun
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
    }
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
        model: 'gpt-5.4',
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
    expect(contentDeltas.some((c) => c.startsWith('```ts\nls'))).toBe(true)
    expect(contentDeltas.some((c) => c.includes('output chunk'))).toBe(true)
    expect(contentDeltas.some((c) => c.includes('…'))).toBe(true)
    expect(contentDeltas.some((c) => c.includes('---'))).toBe(false)
    expect(contentDeltas.some((c) => c.includes('exit 0'))).toBe(true)
    expect(contentDeltas.some((c) => c.includes('pwd'))).toBe(true)
    expect((contentDeltas.at(-1) ?? '').includes('```')).toBe(true)

    const reasoningChunk = chunks.find((c) => c.choices?.[0]?.delta?.reasoning_content)
    expect(typeof reasoningChunk?.choices?.[0]?.delta?.reasoning_content).toBe('string')
    expect(reasoningChunk?.choices?.[0]?.delta?.content).toBeUndefined()

    const usageChunk = chunks.find((c) => c.usage)
    expect(usageChunk?.usage?.completion_tokens).toBe(2)
  })

  it('removes reasoning details from command output', async () => {
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield {
            type: 'tool',
            toolKind: 'command',
            id: 'tool-1',
            status: 'started',
            title: 'bun install',
          }
          yield {
            type: 'tool',
            toolKind: 'command',
            id: 'tool-1',
            status: 'delta',
            title: 'bun install',
            delta: 'Installing\n<details type="reasoning" done="true" duration="0">',
          }
          yield {
            type: 'tool',
            toolKind: 'command',
            id: 'tool-1',
            status: 'delta',
            title: 'bun install',
            delta: '<summary>Thought for 0 seconds</summary>\nWaiting</details>\nDone',
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
        model: 'gpt-5.4',
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

    expect(content).toContain('Installing')
    expect(content).toContain('Done')
    expect(content).not.toContain('<details')
    expect(content).not.toContain('Thought for 0 seconds')
  })

  it('starts command fences on a fresh line after text', async () => {
    const command = 'bash -lc "echo hi"'
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'message', delta: 'hello' }
          yield { type: 'tool', toolKind: 'command', id: 'cmd-1', status: 'started', title: command }
          yield { type: 'tool', toolKind: 'command', id: 'cmd-1', status: 'completed', title: command }
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
        model: 'gpt-5.4',
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

    expect(contentChunks.join('')).toContain('hello\n```ts')
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
        model: 'gpt-5.4',
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
        model: 'gpt-5.4',
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
    const rawCommand = '/bin/bash -lc \'rg -n "jangar" packages | head\''
    const displayCommand = 'rg -n "jangar" packages | head'
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'tool', toolKind: 'command', id: 'tool-1', status: 'started', title: rawCommand }
          yield {
            type: 'tool',
            toolKind: 'command',
            id: 'tool-1',
            status: 'delta',
            title: rawCommand,
            delta:
              'packages/cx-tools/README.md:7:Artifacts are expected to build into `dist/`\npackages/scripts/README.md:17:| `src/jangar/build-image.ts` | Builds and pushes the `lab/jangar` Bun worker image',
          }
          yield { type: 'tool', toolKind: 'command', id: 'tool-1', status: 'completed', title: rawCommand }
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
        model: 'gpt-5.4',
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

    // Keep the opening fence attached to the first command chunk so markdown clients render it as code while streaming.
    expect(contentChunks.length).toBe(3)
    const [commandChunk, outputChunk, closingFence] = contentChunks

    expect(commandChunk.startsWith('```ts\n')).toBe(true)
    expect(commandChunk).toContain(displayCommand)
    expect(commandChunk).not.toContain(rawCommand)
    expect(closingFence.includes('```')).toBe(true)

    // Command string should not reappear inside output chunk, and output starts on its own line.
    expect(outputChunk.startsWith(displayCommand)).toBe(false)
    expect(outputChunk.includes(displayCommand)).toBe(false)
    expect(outputChunk.includes(rawCommand)).toBe(false)

    // Only one appearance of the command line across all streamed content.
    const joinedContent = contentChunks.join('')
    const occurrences = joinedContent.split(displayCommand).length - 1
    expect(occurrences).toBe(1)
    expect(joinedContent.includes(rawCommand)).toBe(false)
    expect(joinedContent.includes('\n---\n')).toBe(false)
  })

  it('renders aggregated command output when no output deltas were streamed', async () => {
    const rawCommand =
      "/bin/bash -lc 'cd /workspace/lab && cat services/jangar/src/routes/openai/v1/chat/completions.ts'"
    const displayCommand = 'cd /workspace/lab && cat services/jangar/src/routes/openai/v1/chat/completions.ts'
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'tool', toolKind: 'command', id: 'cmd-1', status: 'started', title: rawCommand }
          yield {
            type: 'tool',
            toolKind: 'command',
            id: 'cmd-1',
            status: 'completed',
            title: rawCommand,
            data: {
              aggregatedOutput:
                "import { createFileRoute } from '@tanstack/react-router'\nimport { handleChatCompletion } from '~/server/chat'\n",
            },
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
        model: 'gpt-5.4',
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

    expect(contentChunks[0]?.startsWith('```ts\n')).toBe(true)
    expect(contentChunks.some((chunk) => chunk.includes(displayCommand))).toBe(true)
    expect(contentChunks.some((chunk) => chunk.includes(rawCommand))).toBe(false)
    expect(
      contentChunks.some((chunk) => chunk.includes("import { createFileRoute } from '@tanstack/react-router'")),
    ).toBe(true)
  })

  it('logs tool event decode failures with a searchable tag', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          yield {
            type: 'tool',
            // Invalid types on purpose: should trigger schema decode failure.
            toolKind: 123,
            id: 456,
            status: 'started',
            title: 'bad tool',
          } as unknown
          yield { type: 'message', delta: 'ok' }
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
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })

    const response = await chatCompletionsHandler(request)
    expect(response.status).toBe(200)
    await response.text()

    expect(warnSpy.mock.calls.some((call) => call[0] === '[jangar][tool-event][decode-failed]')).toBe(true)

    warnSpy.mockRestore()
  })

  it('does not insert separators between two commands', async () => {
    const rawCommandA = 'bash -lc "echo first"'
    const rawCommandB = 'bash -lc "echo second"'
    const displayCommandA = 'echo first'
    const displayCommandB = 'echo second'
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          // First command
          yield { type: 'tool', toolKind: 'command', id: 'cmd-1', status: 'started', title: rawCommandA }
          yield {
            type: 'tool',
            toolKind: 'command',
            id: 'cmd-1',
            status: 'delta',
            title: rawCommandA,
            delta: 'first output',
          }
          yield { type: 'tool', toolKind: 'command', id: 'cmd-1', status: 'completed', title: rawCommandA }

          // Second command
          yield { type: 'tool', toolKind: 'command', id: 'cmd-2', status: 'started', title: rawCommandB }
          yield {
            type: 'tool',
            toolKind: 'command',
            id: 'cmd-2',
            status: 'delta',
            title: rawCommandB,
            delta: 'second output',
          }
          yield { type: 'tool', toolKind: 'command', id: 'cmd-2', status: 'completed', title: rawCommandB }
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
        model: 'gpt-5.4',
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

    const joined = contentChunks.join('')

    // No separators should appear anywhere.
    const firstCommandIndex = joined.indexOf(displayCommandA)
    expect(firstCommandIndex).toBeGreaterThanOrEqual(0)
    const secondCommandIndex = joined.indexOf(displayCommandB)
    expect(secondCommandIndex).toBeGreaterThan(firstCommandIndex)
    expect(joined.includes('\n---\n')).toBe(false)

    // Ensure consecutive commands are separated by a blank line.
    expect(joined).toContain(`first output\n\n${displayCommandB}`)
  })

  it('streams five commands without inserting separators', async () => {
    const commands = [
      'bash -lc "echo one"',
      'bash -lc "echo two"',
      'bash -lc "echo three"',
      'bash -lc "echo four"',
      'bash -lc "echo five"',
    ]

    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          for (const [idx, command] of commands.entries()) {
            const id = `cmd-${idx + 1}`
            yield { type: 'tool', toolKind: 'command', id, status: 'started', title: command }
            yield { type: 'tool', toolKind: 'command', id, status: 'delta', title: command, delta: `output ${idx + 1}` }
            yield { type: 'tool', toolKind: 'command', id, status: 'completed', title: command }
          }
          yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 5 } }
        })(),
      }),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }
    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-5.4',
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

    // Expect an opening fence, then per-command lines and outputs, and a single closing fence — no separators.
    const joined = contentChunks.join('')
    const separatorCount = (joined.match(/\n---\n/g) ?? []).length
    expect(separatorCount).toBe(0)

    // Ensure fences exist once at start and end.
    const opens = contentChunks.filter((c) => c.startsWith('```ts')).length
    expect(opens).toBe(1)
    expect(joined.endsWith('```\n\n')).toBe(true)
  })

  it('does not insert a separator when the prior command produced no visible content', async () => {
    const rawCommand = 'bash -lc "echo noisy"'
    const displayCommand = 'echo noisy'
    const mockClient = {
      runTurnStream: async () => ({
        turnId: 'turn-1',
        threadId: 'thread-1',
        stream: (async function* () {
          // A command that never streams content (no title/detail/delta)
          yield { type: 'tool', toolKind: 'command', id: 'cmd-empty', status: 'completed' }

          // A real command with output
          yield { type: 'tool', toolKind: 'command', id: 'cmd-noisy', status: 'started', title: rawCommand }
          yield {
            type: 'tool',
            toolKind: 'command',
            id: 'cmd-noisy',
            status: 'delta',
            title: rawCommand,
            delta: 'noisy output',
          }
          yield { type: 'tool', toolKind: 'command', id: 'cmd-noisy', status: 'completed', title: rawCommand }

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
        model: 'gpt-5.4',
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

    // No separator should appear because the first command never produced visible content.
    expect(joined.includes('\n---\n')).toBe(false)
    expect(joined).toContain(displayCommand)
    expect(joined).toContain('noisy output')
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
        model: 'gpt-5.4',
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
        model: 'gpt-5.4',
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
        model: 'gpt-5.4',
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
        model: 'gpt-5.4',
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
      body: JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }], stream: true }),
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
        model: 'gpt-5.4',
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

    expect(content).toBe('\nfirst second')

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
      body: JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }], stream: true }),
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
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    expect(text.trim().endsWith('[DONE]')).toBe(true)
    const chunks = text
      .trim()
      .split('\n\n')
      .map((part) => part.replace(/^data: /, ''))
      .filter((part) => part !== '[DONE]')
      .map((part) => JSON.parse(part))
    const errorChunk = chunks.find((chunk) => chunk.error)
    expect(String(errorChunk?.error?.message)).toMatch(/messages/)
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
      body: JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }], stream: true }),
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
    expect(stopChunks).toHaveLength(1)
  })

  it('normalizes app-server error notifications to OpenAI error shape', async () => {
    const mockClient = {
      runTurnStream: vi.fn(async () => {
        return {
          turnId: 'turn-1',
          threadId: 'thread-1',
          stream: (async function* () {
            yield {
              type: 'error',
              error: {
                error: { message: 'conversation not found: stale-thread', codexErrorInfo: null },
                willRetry: false,
                threadId: 'thread-1',
                turnId: 'turn-1',
              },
            }
          })(),
        }
      }),
      interruptTurn: vi.fn(async () => {}),
      stop: vi.fn(),
      ensureReady: vi.fn(),
    }
    setCodexClientFactory(() => mockClient as unknown as CodexAppServerClient)

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })

    const response = await chatCompletionsHandler(request)

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text.trim().endsWith('[DONE]')).toBe(true)

    const chunks = text
      .trim()
      .split('\n\n')
      .map((part) => part.replace(/^data: /, ''))
      .filter((part) => part !== '[DONE]')
      .map((part) => JSON.parse(part))

    const errorChunk = chunks.find((chunk) => chunk.error)
    expect(errorChunk).toBeTruthy()
    expect(typeof errorChunk?.error?.message).toBe('string')
    expect(String(errorChunk?.error?.message)).not.toBe('[object Object]')
    expect(String(errorChunk?.error?.message)).toMatch(/conversation not found/)
  })
})
