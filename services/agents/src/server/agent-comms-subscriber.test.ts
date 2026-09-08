import { type JsMsg, StringCodec } from 'nats'
import { describe, expect, it, vi } from 'vitest'

import { __test__ } from '~/server/agent-comms-subscriber'
import { publishAgentMessages } from '~/server/agent-messages-bus'
import type { AgentMessageRecord } from '~/server/agent-messages-store'
import { recordAgentCommsBatch, recordAgentCommsError } from '~/server/metrics'

vi.mock('~/server/agent-messages-bus', () => ({
  publishAgentMessages: vi.fn(),
}))

vi.mock('~/server/metrics', () => ({
  recordAgentCommsBatch: vi.fn(),
  recordAgentCommsError: vi.fn(),
}))

const toBytes = (value: string) => new TextEncoder().encode(value)

const buildRecord = (input: Record<string, unknown>, index: number): AgentMessageRecord => ({
  id: `msg-${index}`,
  agentRunUid: null,
  agentRunName: null,
  agentRunNamespace: null,
  runId: null,
  stepId: null,
  agentId: null,
  role: String(input.role ?? 'assistant'),
  kind: String(input.kind ?? 'message'),
  timestamp: new Date().toISOString(),
  channel: null,
  stage: null,
  content: String(input.content ?? ''),
  attrs: {},
  dedupeKey: null,
  createdAt: new Date().toISOString(),
})

const createMessage = (payload: Record<string, unknown>, subject: string) =>
  ({
    data: toBytes(JSON.stringify(payload)),
    subject,
    ack: vi.fn(),
  }) as unknown as JsMsg

const createStream = (messages: JsMsg[]) =>
  ({
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message
      }
    },
    stop: vi.fn(),
    close: vi.fn(async () => {}),
    // biome-ignore lint/suspicious/noConfusingVoidType: align with MessageStream close signature.
  }) as AsyncIterable<JsMsg> & { stop: () => void; close: () => Promise<void | Error> }

describe('agent comms subscriber consume', () => {
  it('acks messages after insert and records batch metrics', async () => {
    const recordBatch = vi.mocked(recordAgentCommsBatch)
    const sc = StringCodec()
    const insertMessages = vi.fn(async (inputs: unknown[]) =>
      inputs.map((input, index) => buildRecord(input as Record<string, unknown>, index)),
    )
    const store = {
      insertMessages,
      hasMessages: vi.fn(async () => false),
      listMessages: vi.fn(async () => []),
      close: vi.fn(async () => {}),
    }
    const abortController = new AbortController()
    const config = { pullBatchSize: 2, pullExpiresMs: 0 } as Parameters<typeof __test__.consumeStream>[3]

    const subject = 'agentrun.agents.demo.abc.agent.codex.message'
    const msgA = createMessage({ content: 'hello' }, subject)
    const msgB = createMessage({ content: 'world' }, subject)

    await __test__.consumeStream(createStream([msgA, msgB]), sc, store, config, abortController.signal)

    expect(insertMessages).toHaveBeenCalledTimes(1)
    expect(recordBatch.mock.calls[0][0]).toBe(2)
    expect(publishAgentMessages).toHaveBeenCalledTimes(1)
    expect(msgA.ack).toHaveBeenCalledTimes(1)
    expect(msgB.ack).toHaveBeenCalledTimes(1)
  })

  it('acks decode failures immediately and records decode errors', async () => {
    const recordError = vi.mocked(recordAgentCommsError)
    const sc = StringCodec()
    const insertMessages = vi.fn(async (inputs: unknown[]) =>
      inputs.map((input, index) => buildRecord(input as Record<string, unknown>, index)),
    )
    const store = {
      insertMessages,
      hasMessages: vi.fn(async () => false),
      listMessages: vi.fn(async () => []),
      close: vi.fn(async () => {}),
    }
    const abortController = new AbortController()
    const config = { pullBatchSize: 1, pullExpiresMs: 0 } as Parameters<typeof __test__.consumeStream>[3]

    const subject = 'agentrun.agents.demo.abc.agent.codex.message'
    const badMsg = createMessage({ role: 'assistant' }, subject)
    const goodMsg = createMessage({ content: 'ok' }, subject)

    await __test__.consumeStream(createStream([badMsg, goodMsg]), sc, store, config, abortController.signal)

    expect(badMsg.ack).toHaveBeenCalledTimes(1)
    expect(recordError.mock.calls[0][0]).toBe('decode')
    expect(goodMsg.ack).toHaveBeenCalledTimes(1)
    expect(insertMessages).toHaveBeenCalledTimes(1)
  })

  it('normalizes canonical AgentRun subject families for Agents visibility', () => {
    const agentRun = __test__.normalizePayload(
      JSON.stringify({
        content: 'agentrun update',
        agent_run_id: 'run-1',
        agent_run_name: 'demo',
        agent_run_namespace: 'agents',
        agent_run_uid: 'abc',
        agent_run_stage: 'implementation',
      }),
      'agentrun.agents.demo.abc.agent.codex.status',
    )
    const general = __test__.normalizePayload(JSON.stringify({ content: 'general update' }), 'agentrun.general.status')
    expect(agentRun?.runId).toBe('run-1')
    expect(agentRun?.agentRunName).toBe('demo')
    expect(agentRun?.agentRunNamespace).toBe('agents')
    expect(agentRun?.agentRunUid).toBe('abc')
    expect(agentRun?.stage).toBe('implementation')
    expect(agentRun?.attrs?.runtime).toBe('agents_comms')
    expect(general?.channel).toBe('general')
    expect(general?.attrs?.runtime).toBe('agents_comms')
    expect(
      __test__.normalizePayload(JSON.stringify({ content: 'alias update' }), 'agents.agentrun.agents.demo.abc.status'),
    ).toBeNull()
    expect(
      __test__.normalizePayload(JSON.stringify({ content: 'stored update' }), 'agents.agent_messages.general.status'),
    ).toBeNull()
    expect(
      __test__.normalizePayload(JSON.stringify({ content: 'native update' }), 'workflow.general.status'),
    ).toBeNull()
    expect(
      __test__.normalizePayload(JSON.stringify({ content: 'agents update' }), 'agents.workflow.general.status'),
    ).toBeNull()
    expect(
      __test__.normalizePayload(JSON.stringify({ content: 'argo update' }), 'argo.workflow.general.status'),
    ).toBeNull()
    expect(
      __test__.normalizePayload(
        JSON.stringify({ content: 'legacy stored update' }),
        'workflow_comms.agent_messages.general.status',
      ),
    ).toBeNull()
  })

  it('ignores legacy workflow payload identity and uses Agents subject identity', () => {
    const message = __test__.normalizePayload(
      JSON.stringify({
        content: 'canonical update',
        workflow_name: 'legacy-workflow',
        workflow_namespace: 'legacy',
        workflow_uid: 'legacy-uid',
      }),
      'agentrun.agents.agent-run.agent-run-uid.agent.codex.status',
    )

    expect(message?.agentRunName).toBe('agent-run')
    expect(message?.agentRunNamespace).toBe('agents')
    expect(message?.agentRunUid).toBe('agent-run-uid')
  })

  it('keeps swarm persona attrs out of canonical agent and role fields', () => {
    const message = __test__.normalizePayload(
      JSON.stringify({
        agent_id: 'Unknown',
        role: 'Assistant',
        kind: 'run-started',
        content: 'release started',
        attrs: {
          swarmAgentIdentity: 'platform-runtime-deployer',
          swarmAgentRole: 'deployer',
          swarmHumanName: 'Platform Runtime',
        },
      }),
      'agentrun.general.run-started',
    )

    expect(message?.agentId).toBe('Unknown')
    expect(message?.role).toBe('Assistant')
    expect(message?.attrs?.swarmHumanName).toBe('Platform Runtime')
  })

  it('recreates an existing consumer when filter subjects are stale', async () => {
    const info = vi.fn(async () => ({
      config: {
        ack_policy: 'explicit',
        deliver_policy: 'all',
        durable_name: 'agents-agent-comms',
        filter_subjects: ['agentrun.>', 'agents.agentrun.>'],
        max_ack_pending: 20000,
      },
    }))
    const remove = vi.fn(async () => {})
    const add = vi.fn(async () => {})
    const manager = {
      consumers: {
        info,
        delete: remove,
        add,
      },
    }

    await __test__.ensureConsumer(
      manager as never,
      {
        ackWaitMs: 30000,
        consumerDescription: 'Agents communications dependency check',
        consumerName: 'agents-agent-comms',
        filterSubjects: ['agentrun.>'],
        maxAckPending: 20000,
        streamName: 'agent-comms',
      } as never,
    )

    expect(remove).toHaveBeenCalledWith('agent-comms', 'agents-agent-comms')
    expect(add).toHaveBeenCalledWith(
      'agent-comms',
      expect.objectContaining({
        durable_name: 'agents-agent-comms',
        filter_subjects: ['agentrun.>'],
      }),
    )
  })
})
