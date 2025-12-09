import { describe, expect, it } from 'bun:test'

import type { StreamDelta } from '@proompteng/codex'

type FinalizeInfo = {
  outcome: 'succeeded' | 'failed' | 'aborted' | 'timeout' | 'error'
  reason?: string
}

import { streamSse } from './stream'

const buildMockAppServer = ({
  deltas,
  returnValue = null,
  delayMs = 0,
  hang = false,
}: {
  deltas: StreamDelta[]
  returnValue?: unknown
  delayMs?: number
  hang?: boolean
}) => {
  const interruptCalls: Array<{ threadId: string; turnId: string }> = []

  const runTurnStream = async () => {
    async function* generator() {
      if (hang) {
        // never yield or return; simulates a stuck Codex turn
        // eslint-disable-next-line no-constant-condition
        while (true) {
          await Bun.sleep(1000)
        }
      }

      for (const delta of deltas) {
        if (delayMs) await Bun.sleep(delayMs)
        yield delta
      }
      return returnValue as never
    }

    return { stream: generator(), threadId: 'thread-1', turnId: 'codex-1' }
  }

  const interruptTurn = async ({ threadId, turnId }: { threadId: string; turnId: string }) => {
    interruptCalls.push({ threadId, turnId })
  }

  return { runTurnStream, interruptTurn, interruptCalls }
}

const readAll = async (res: Response) => {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

describe('streamSse lifecycle', () => {
  it('calls onFinalize once on success', async () => {
    const mock = buildMockAppServer({ deltas: [{ type: 'message', delta: 'hi' }] })
    let finalized: FinalizeInfo | null = null

    const res = await streamSse('prompt', {
      model: 'gpt-5.1-codex-max',
      signal: new AbortController().signal,
      chatId: 'chat-finalize',
      db: {
        // minimal mocks for persistence used in the stream helper
        appendEvent: async () => {},
        appendUsage: async () => {},
        appendReasoning: async () => {},
        upsertTurn: async () => {},
        upsertConversation: async () => {},
        appendMessage: async () => {},
      } as never,
      conversationId: 'chat-finalize',
      turnId: 'turn-1',
      userId: 'user',
      startedAt: Date.now(),
      onFinalize: (info) => {
        finalized = info
      },
      appServer: mock as never,
    })

    const text = await readAll(res)
    expect(text).toContain('[DONE]')
    if (!finalized) throw new Error('onFinalize was not called')
    const info = finalized as FinalizeInfo
    expect(info.outcome).toBe('succeeded')
    expect(mock.interruptCalls).toHaveLength(0)
  })

  it('swallows onFinalize errors after a completed stream', async () => {
    const mock = buildMockAppServer({ deltas: [{ type: 'message', delta: 'hi' }] })
    let finalizeCalls = 0

    const res = await streamSse('prompt', {
      model: 'gpt-5.1-codex-max',
      signal: new AbortController().signal,
      chatId: 'chat-finalize-throw',
      db: {
        // minimal mocks for persistence used in the stream helper
        appendEvent: async () => {},
        appendUsage: async () => {},
        appendReasoning: async () => {},
        upsertTurn: async () => {},
        upsertConversation: async () => {},
        appendMessage: async () => {},
      } as never,
      conversationId: 'chat-finalize',
      turnId: 'turn-1',
      userId: 'user',
      startedAt: Date.now(),
      onFinalize: (_info) => {
        finalizeCalls += 1
        throw new Error('finalize failed')
      },
      appServer: mock as never,
    })

    const text = await readAll(res)
    expect(text).toContain('[DONE]')
    expect(finalizeCalls).toBe(1)
    expect(mock.interruptCalls).toHaveLength(0)
  })

  it('returns an SSE error response when the app server fails before streaming', async () => {
    const mock = {
      runTurnStream: async () => {
        throw new Error('failed to start stream')
      },
    }

    const res = await streamSse('prompt', {
      model: 'gpt-5.1-codex-max',
      signal: new AbortController().signal,
      chatId: 'chat-error',
      db: {
        appendEvent: async () => {},
        appendUsage: async () => {},
        appendReasoning: async () => {},
        upsertTurn: async () => {},
        upsertConversation: async () => {},
        appendMessage: async () => {},
      } as never,
      conversationId: 'chat-error',
      turnId: 'turn-error',
      userId: 'user',
      startedAt: Date.now(),
      appServer: mock as never,
    })

    const text = await readAll(res)
    expect(res.status).toBe(500)
    expect(text).toContain('failed to start stream')
    expect(text).toContain('[DONE]')
  })

  it('swallows onFinalize errors when context window is exceeded before streaming', async () => {
    const error = { message: 'ctx exceeded', codexErrorInfo: 'contextWindowExceeded' }
    const mock = {
      runTurnStream: async () => {
        throw error
      },
    }

    let finalizeCalls = 0

    const res = await streamSse('prompt', {
      model: 'gpt-5.1-codex-max',
      signal: new AbortController().signal,
      chatId: 'chat-context-window',
      db: {
        appendEvent: async () => {},
        appendUsage: async () => {},
        appendReasoning: async () => {},
        upsertTurn: async () => {},
        upsertConversation: async () => {},
        appendMessage: async () => {},
      } as never,
      conversationId: 'chat-context-window',
      turnId: 'turn-ctx',
      userId: 'user',
      startedAt: Date.now(),
      onFinalize: () => {
        finalizeCalls += 1
        throw new Error('finalize failed')
      },
      appServer: mock as never,
    })

    const text = await readAll(res)
    expect(text).toContain('context_window_exceeded')
    expect(finalizeCalls).toBe(1)
    expect(res.status).toBe(200)
  })

  it('interrupts Codex and finalizes on abort', async () => {
    const mock = buildMockAppServer({ deltas: [], hang: true })
    const controller = new AbortController()
    let finalized: FinalizeInfo | null = null

    const resPromise = streamSse('prompt', {
      model: 'gpt-5.1-codex-max',
      signal: controller.signal,
      chatId: 'chat-abort',
      db: {
        appendEvent: async () => {},
        appendUsage: async () => {},
        appendReasoning: async () => {},
        upsertTurn: async () => {},
        upsertConversation: async () => {},
        appendMessage: async () => {},
      } as never,
      conversationId: 'chat-abort',
      turnId: 'turn-2',
      userId: 'user',
      startedAt: Date.now(),
      onFinalize: (info) => {
        finalized = info
      },
      appServer: mock as never,
    })

    // Abort shortly after starting
    setTimeout(() => controller.abort(), 10)
    const res = await resPromise
    await readAll(res)
    await Bun.sleep(20)

    if (!finalized) throw new Error('onFinalize was not called')
    const info = finalized as FinalizeInfo
    expect(info.outcome).toBe('aborted')
    expect(mock.interruptCalls).toEqual([{ threadId: 'thread-1', turnId: 'codex-1' }])
  })

  it('times out and interrupts Codex when no deltas are produced', async () => {
    const originalTimeout = process.env.JANGAR_STREAM_TIMEOUT_MS
    process.env.JANGAR_STREAM_TIMEOUT_MS = '10'

    const mock = buildMockAppServer({ deltas: [], hang: true })
    let finalized: FinalizeInfo | null = null

    const res = await streamSse('prompt', {
      model: 'gpt-5.1-codex-max',
      signal: new AbortController().signal,
      chatId: 'chat-timeout',
      db: {
        appendEvent: async () => {},
        appendUsage: async () => {},
        appendReasoning: async () => {},
        upsertTurn: async () => {},
        upsertConversation: async () => {},
        appendMessage: async () => {},
      } as never,
      conversationId: 'chat-timeout',
      turnId: 'turn-3',
      userId: 'user',
      startedAt: Date.now(),
      onFinalize: (info) => {
        finalized = info
      },
      appServer: mock as never,
    })

    await readAll(res)
    await Bun.sleep(20)

    if (!finalized) throw new Error('onFinalize was not called')
    const info = finalized as FinalizeInfo
    expect(info.outcome).toBe('timeout')
    expect(mock.interruptCalls).toEqual([{ threadId: 'thread-1', turnId: 'codex-1' }])
    process.env.JANGAR_STREAM_TIMEOUT_MS = originalTimeout
  })
})
