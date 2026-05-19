import { Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { AgentMessagesPublisher, AgentMessagesStoreFactory } from '../../../server/agent-messages-api'
import type { AgentMessageInput, AgentMessagesStore } from '../../../server/agent-messages-store'
import { postAgentMessagesHandler } from './messages'

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

const createLayer = (store: AgentMessagesStore) =>
  Layer.merge(
    Layer.succeed(AgentMessagesStoreFactory, {
      create: Effect.succeed(store),
    }),
    Layer.succeed(AgentMessagesPublisher, {
      publish: vi.fn(() => Effect.void),
    }),
  )

describe('agent messages route', () => {
  it('returns inserted messages from the injected store', async () => {
    const store = createStore()
    const response = await postAgentMessagesHandler(
      new Request('http://agents.local/api/agents/messages', {
        body: JSON.stringify({
          messages: [
            {
              runId: 'run-1',
              timestamp: '2026-05-19T12:00:00.000Z',
              content: 'hello',
              dedupeKey: 'run-1:1',
            },
          ],
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      createLayer(store),
    )

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({ ok: true, inserted: 1, skipped: false })
  })

  it('maps invalid payloads to HTTP 400', async () => {
    const response = await postAgentMessagesHandler(
      new Request('http://agents.local/api/agents/messages', {
        body: JSON.stringify({ messages: [{ runId: 'run-1' }] }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      createLayer(createStore()),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'messages[0].content is required' })
  })
})
