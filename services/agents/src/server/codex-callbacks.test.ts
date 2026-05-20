import { Effect, Layer } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { AgentMessagesPublisher, AgentMessagesStoreFactory } from './agent-messages-api'
import type { AgentMessageInput, AgentMessagesStore } from './agent-messages-store'
import { buildCodexCallbackMessage, postCodexCallbackHandler } from './codex-callbacks'

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

describe('Codex callback ingestion', () => {
  it('maps notify callbacks into generic agent messages', () => {
    const built = buildCodexCallbackMessage('notify', {
      agent_run_name: 'agent-run-1',
      agent_run_namespace: 'agents',
      stage: 'implementation',
      last_assistant_message: 'opened PR',
      repository: 'proompteng/lab',
    })

    expect(built.callback).toMatchObject({
      kind: 'notify',
      agentRunName: 'agent-run-1',
      agentRunNamespace: 'agents',
      runId: 'agent-run-1',
      stage: 'implementation',
    })
    expect(built.message).toMatchObject({
      agentId: 'codex',
      channel: 'general',
      content: 'opened PR',
      kind: 'codex.notify',
      runId: 'agent-run-1',
      stage: 'implementation',
    })
    expect(built.message.attrs).toMatchObject({
      callbackKind: 'notify',
      repository: 'proompteng/lab',
    })
  })

  it('accepts AgentRun metadata callback envelopes', async () => {
    const store = createStore()
    const response = await postCodexCallbackHandler(
      'run-complete',
      new Request('http://agents.local/api/agents/codex/run-complete', {
        body: JSON.stringify({
          data: {
            metadata: { name: 'agent-run-2', namespace: 'agents', uid: 'agent-run-uid-2' },
            status: { phase: 'Succeeded', finishedAt: '2026-05-19T12:00:00.000Z' },
            stage: 'judge',
            artifacts: [{ name: 'implementation-log', key: 'agent-run-2/log.txt' }],
          },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      createLayer(store),
    )

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      callback: {
        kind: 'run-complete',
        agentRunName: 'agent-run-2',
        agentRunNamespace: 'agents',
        agentRunUid: 'agent-run-uid-2',
        runId: 'agent-run-uid-2',
      },
      inserted: [{ kind: 'codex.run-complete', content: 'Codex run completed with phase Succeeded' }],
      skipped: false,
    })
    expect(store.insertMessages).toHaveBeenCalledTimes(1)
  })

  it('rejects callbacks without AgentRun identity', async () => {
    const response = await postCodexCallbackHandler(
      'notify',
      new Request('http://agents.local/api/agents/codex/notify', {
        body: JSON.stringify({ data: { message: 'missing identity' } }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      createLayer(createStore()),
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'callback payload must include agentRunName, agentRunUid, or runId',
    })
  })
})
