import { describe, expect, it } from 'bun:test'

import type { DbClient } from '~/services/db'
import { threadMap } from './state'
import { streamSse } from './stream'

type UpsertTurnInput = Parameters<DbClient['upsertTurn']>[0]
type AppendUsageInput = Parameters<DbClient['appendUsage']>[0]
type AppendEventInput = Parameters<DbClient['appendEvent']>[0]

const createMockDb = () => {
  const calls = {
    appendUsage: [] as Array<{ turnId: string }>,
    appendEvent: [] as Array<{ method: string; turnId?: string }>,
    upsertTurn: [] as Array<{ turnId: string; status: string }>,
  }

  const noop = async (): Promise<string> => 'ok'
  const db: DbClient = {
    upsertConversation: noop,
    upsertTurn: async (input: UpsertTurnInput) => {
      calls.upsertTurn.push({ turnId: input.turnId, status: input.status })
      return 'turn'
    },
    appendMessage: noop,
    appendReasoning: noop,
    appendUsage: async (input: AppendUsageInput) => {
      calls.appendUsage.push({ turnId: input.turnId })
      return 'usage'
    },
    appendRateLimit: noop,
    upsertCommand: noop,
    appendCommandChunk: noop,
    appendEvent: async (input: AppendEventInput) => {
      const event: { method: string; turnId?: string } = { method: input.method }
      if (input.turnId) event.turnId = input.turnId
      calls.appendEvent.push(event)
      return 'event'
    },
    appendAssistantMessageWithMeta: noop,
  }

  return { db, calls }
}

const runStream = async (opts: Parameters<typeof streamSse>[1]) => {
  const res = await streamSse('hello', opts)
  const text = await res.text()
  return { res, text }
}

describe('streamSse', () => {
  it('keeps DB turnId when Codex returns a different turnId', async () => {
    const { db, calls } = createMockDb()
    const appServer = {
      runTurnStream: async () => ({
        turnId: 'codex-turn-99',
        threadId: 'thread-1',
        stream: (async function* () {
          yield { type: 'usage', usage: { input_tokens: 5 } }
          yield 'done'
        })(),
      }),
    }

    await runStream({
      model: 'gpt-5.1-codex-max',
      signal: new AbortController().signal,
      chatId: 'chat-1',
      includeUsage: true,
      db,
      conversationId: 'conv-1',
      turnId: 'db-turn-1',
      userId: 'user-1',
      startedAt: Date.now(),
      appServer: appServer as never,
    })

    expect(calls.appendUsage.map((u) => u.turnId)).toEqual(['db-turn-1'])
  })

  it('persists onComplete errors without emitting server_error SSE after [DONE]', async () => {
    const { db, calls } = createMockDb()
    const appServer = {
      runTurnStream: async () => ({
        threadId: 'thread-2',
        stream: (async function* () {
          yield 'hello'
        })(),
      }),
    }

    const { text } = await runStream({
      model: 'gpt-5.1-codex-max',
      signal: new AbortController().signal,
      chatId: 'chat-2',
      db,
      conversationId: 'conv-2',
      turnId: 'db-turn-2',
      userId: 'user-2',
      startedAt: Date.now(),
      appServer: appServer as never,
      onComplete: async () => {
        throw new Error('persist failed')
      },
    })

    expect(text).not.toContain('server_error')
    expect(text.trim().endsWith('[DONE]')).toBe(true)
    expect(calls.appendEvent.some((e) => e.method === 'turn/persist_error')).toBe(true)
    expect(calls.upsertTurn.some((t) => t.status === 'succeeded')).toBe(true)
  })

  it('clears threadMap when context window is exceeded mid-stream', async () => {
    const { db } = createMockDb()
    const chatId = 'chat-context'

    const appServer = {
      runTurnStream: async () => ({
        threadId: 'thread-context',
        stream: (async function* () {
          yield 'chunk'
          throw new Error(JSON.stringify({ error: { codexErrorInfo: 'contextWindowExceeded', message: 'too long' } }))
        })(),
      }),
    }

    await runStream({
      model: 'gpt-5.1-codex-max',
      signal: new AbortController().signal,
      chatId,
      db,
      conversationId: 'conv-ctx',
      turnId: 'turn-ctx',
      userId: 'user-ctx',
      startedAt: Date.now(),
      appServer: appServer as never,
    })

    expect(threadMap.get(chatId)).toBeUndefined()
  })

  it('emits each unique reasoning delta only once', async () => {
    const { db } = createMockDb()
    const appServer = {
      runTurnStream: async () => ({
        threadId: 'thread-reasoning',
        turnId: 'turn-reasoning',
        stream: (async function* () {
          yield { type: 'reasoning', delta: '**Acknowled**' }
          yield { type: 'reasoning', delta: '**Acknowled**' }
          yield { type: 'reasoning', delta: 'Acknowledging completion' }
        })(),
      }),
    }

    const { text } = await runStream({
      model: 'gpt-5.1-codex-max',
      signal: new AbortController().signal,
      chatId: 'chat-reasoning',
      db,
      conversationId: 'conv-reasoning',
      turnId: 'turn-reasoning',
      userId: 'user-reasoning',
      startedAt: Date.now(),
      appServer: appServer as never,
    })

    const chunks = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.substring('data: '.length))
      .filter((line) => line !== '[DONE]')
      .map((line) => JSON.parse(line) as { choices?: Array<{ delta?: { reasoning_content?: string } }> })

    type ReasoningChunk = {
      choices: [{ delta: { reasoning_content: string } }]
    }

    const reasoningChunks = chunks.filter(
      (chunk): chunk is ReasoningChunk =>
        typeof chunk.choices?.[0]?.delta?.reasoning_content === 'string',
    )
    const reasoningTexts = reasoningChunks.map((chunk) => chunk.choices[0].delta.reasoning_content)

    expect(reasoningTexts).toEqual(['**Acknowled**', 'Acknowledging completion'])
  })
})
