import { describe, expect, it } from 'bun:test'

import type { StreamDelta } from '@proompteng/codex'
import { persistToolDelta } from './persistence'
import { streamSse } from './stream'
import type { StreamOptions, ToolDelta } from './types'

const makeDbMock = () => {
  const events: Array<Record<string, unknown>> = []
  const usages: Array<Record<string, unknown>> = []
  const commandChunks: Array<{ stream: string; seq: number }> = []
  const commands: Array<{ status: string }> = []
  return {
    events,
    usages,
    commandChunks,
    commands,
    db: {
      appendEvent: async (input: Record<string, unknown>) => {
        events.push(input)
        return ''
      },
      appendUsage: async (input: Record<string, unknown>) => {
        usages.push(input)
        return ''
      },
      appendCommandChunk: async (input: { stream: string; seq: number }) => {
        commandChunks.push({ stream: input.stream, seq: input.seq })
        return ''
      },
      upsertCommand: async (input: { status?: string }) => {
        commands.push({ status: input.status ?? '' })
        return ''
      },
      appendAssistantMessageWithMeta: async () => '',
      upsertConversation: async () => '',
      upsertTurn: async () => '',
      appendMessage: async () => '',
      appendReasoning: async () => '',
      appendRateLimit: async () => '',
    },
  }
}

describe('stream usage handling', () => {
  it('persists usage once per turn and propagates codex turnId', async () => {
    const db = makeDbMock()
    const onCompleteMeta: Record<string, unknown> = {}
    const dbClient = db.db as unknown as StreamOptions['db']

    async function* fakeStream(): AsyncGenerator<StreamDelta, void, unknown> {
      yield { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 } } as StreamDelta
      yield { type: 'message', delta: 'hi' } as StreamDelta
    }

    const options: StreamOptions = {
      model: 'gpt-5.1-codex',
      signal: new AbortController().signal,
      chatId: 'chat-1',
      includeUsage: true,
      appServer: {
        ready: Promise.resolve(),
        runTurnStream: async () => ({ stream: fakeStream(), threadId: 'thread-1', turnId: 'codex-turn' }),
        runTurn: async () => ({ text: '', threadId: '' }),
        stop: () => {},
      },
      db: dbClient,
      conversationId: 'conv-1',
      turnId: 'client-turn',
      userId: 'user-1',
      startedAt: Date.now(),
      onComplete: async (_text, _reasoning, meta) => {
        Object.assign(onCompleteMeta, meta)
      },
    }

    const response = await streamSse('prompt', options)
    await response.text() // drain the stream

    expect(db.usages.length).toBe(1)
    expect(db.events.find((e) => e.method === 'usage')?.turnId).toBe('codex-turn')
    expect(onCompleteMeta.turnId).toBe('codex-turn')
    expect(onCompleteMeta.usagePersisted).toBe(true)
  })
})

describe('persistToolDelta sequencing and streams', () => {
  it('resets sequence after terminal status', async () => {
    const db = makeDbMock()
    const dbClient = db.db as unknown as StreamOptions['db']
    const callId = 'call-1'
    await persistToolDelta(dbClient, 'turn', 'conv', {
      id: callId,
      toolKind: 'command',
      status: 'delta',
      title: 't',
      detail: 'a',
    } as ToolDelta)
    await persistToolDelta(dbClient, 'turn', 'conv', {
      id: callId,
      toolKind: 'command',
      status: 'completed',
      title: 't',
    } as ToolDelta)
    await persistToolDelta(dbClient, 'turn', 'conv', {
      id: callId,
      toolKind: 'command',
      status: 'delta',
      title: 't',
      detail: 'b',
    } as ToolDelta)

    const seqs = db.commandChunks.map((c) => c.seq)
    expect(seqs[0]).toBe(1)
    expect(seqs[seqs.length - 1]).toBe(1)
  })

  it('uses info stream for non-command tool deltas', async () => {
    const db = makeDbMock()
    const dbClient = db.db as unknown as StreamOptions['db']
    await persistToolDelta(dbClient, 'turn', 'conv', {
      id: 'file-1',
      toolKind: 'file',
      status: 'delta',
      title: 'file op',
      detail: 'patched file',
    } as ToolDelta)

    expect(db.commandChunks[0]?.stream).toBe('info')
  })
})
