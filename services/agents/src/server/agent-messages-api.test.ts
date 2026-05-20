import { Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import {
  AgentMessagesPublisher,
  AgentMessagesInvalidPayloadError,
  AgentMessagesStoreFactory,
  ingestAgentMessagesEffect,
  parseAgentMessagesIngestPayload,
} from './agent-messages-api'
import type { AgentMessageInput, AgentMessagesStore } from './agent-messages-store'

vi.mock('./agent-messages-bus', () => ({
  publishAgentMessages: vi.fn(),
}))

const createStoreLayer = (store: AgentMessagesStore) =>
  Layer.merge(
    Layer.succeed(AgentMessagesStoreFactory, {
      create: Effect.succeed(store),
    }),
    Layer.succeed(AgentMessagesPublisher, {
      publish: vi.fn(() => Effect.void),
    }),
  )

const createStore = (overrides: Partial<AgentMessagesStore> = {}): AgentMessagesStore => ({
  close: vi.fn(async () => {}),
  hasMessages: vi.fn(async () => false),
  insertMessages: vi.fn(async (messages: AgentMessageInput[]) =>
    messages.map((message: AgentMessageInput, index: number) => ({
      ...message,
      id: `msg-${index}`,
      attrs: message.attrs ?? {},
      dedupeKey: message.dedupeKey ?? null,
      createdAt: new Date('2026-05-19T12:00:00.000Z').toISOString(),
    })),
  ),
  listMessages: vi.fn(async () => []),
  ...overrides,
})

describe('agent messages ingest API', () => {
  it('parses snake_case and camelCase message payloads', () => {
    const parsed = parseAgentMessagesIngestPayload({
      messages: [
        {
          agent_run_uid: 'agent-run-uid',
          runId: 'run-1',
          role: 'assistant',
          kind: 'message',
          timestamp: '2026-05-19T12:00:00.000Z',
          content: 'hello',
          dedupe_key: 'run-1:1',
        },
      ],
      skip_if_existing: { run_id: 'run-1' },
    })

    expect(parsed.skipIfExisting).toEqual({ runId: 'run-1', agentRunUid: null })
    expect(parsed.messages[0]).toMatchObject({
      agentRunUid: 'agent-run-uid',
      runId: 'run-1',
      content: 'hello',
      dedupeKey: 'run-1:1',
    })
  })

  it('rejects missing messages arrays as typed payload errors', () => {
    expect(() => parseAgentMessagesIngestPayload({ messages: 'bad' })).toThrow(AgentMessagesInvalidPayloadError)
  })

  it('inserts and publishes messages through the injected store', async () => {
    const store = createStore()

    const result = await Effect.runPromise(
      ingestAgentMessagesEffect({
        messages: [
          {
            agentRunUid: null,
            agentRunName: null,
            agentRunNamespace: null,
            runId: 'run-1',
            stepId: null,
            agentId: null,
            role: 'assistant',
            kind: 'message',
            timestamp: '2026-05-19T12:00:00.000Z',
            channel: null,
            stage: null,
            content: 'hello',
            attrs: {},
            dedupeKey: 'run-1:1',
          },
        ],
      }).pipe(Effect.provide(createStoreLayer(store))),
    )

    expect(store.insertMessages).toHaveBeenCalledTimes(1)
    expect(result.inserted).toHaveLength(1)
    expect(result.skipped).toBe(false)
    expect(store.close).toHaveBeenCalledTimes(1)
  })

  it('skips inserts when requested and existing messages are found', async () => {
    const store = createStore({ hasMessages: vi.fn(async () => true) })

    const result = await Effect.runPromise(
      ingestAgentMessagesEffect({
        skipIfExisting: { runId: 'run-1' },
        messages: [
          {
            agentRunUid: null,
            agentRunName: null,
            agentRunNamespace: null,
            runId: 'run-1',
            stepId: null,
            agentId: null,
            role: 'assistant',
            kind: 'message',
            timestamp: '2026-05-19T12:00:00.000Z',
            channel: null,
            stage: null,
            content: 'hello',
            attrs: {},
            dedupeKey: 'run-1:1',
          },
        ],
      }).pipe(Effect.provide(createStoreLayer(store))),
    )

    expect(result).toEqual({ inserted: [], skipped: true })
    expect(store.insertMessages).not.toHaveBeenCalled()
    expect(store.close).toHaveBeenCalledTimes(1)
  })
})
