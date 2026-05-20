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
  workflowUid: null,
  workflowName: null,
  workflowNamespace: null,
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

  it('normalizes Agents-owned subject families for Agents visibility', () => {
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
    const agentsAgentRun = __test__.normalizePayload(
      JSON.stringify({ content: 'agents agentrun update' }),
      'agents.agentrun.agents.demo.abc.agent.codex.status',
    )
    const agentsMessages = __test__.normalizePayload(
      JSON.stringify({ content: 'stored update' }),
      'agents.agent_messages.general.status',
    )
    expect(agentRun?.runId).toBe('run-1')
    expect(agentRun?.workflowName).toBe('demo')
    expect(agentRun?.workflowNamespace).toBe('agents')
    expect(agentRun?.workflowUid).toBe('abc')
    expect(agentRun?.stage).toBe('implementation')
    expect(agentRun?.attrs?.runtime).toBe('agents_comms')
    expect(agentsAgentRun?.workflowName).toBe('demo')
    expect(agentsAgentRun?.attrs?.runtime).toBe('agents_comms')
    expect(agentsMessages?.channel).toBe('general')
    expect(agentsMessages?.attrs?.runtime).toBe('agents_comms')
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

  it('keeps swarm persona attrs out of canonical agent and role fields', () => {
    const message = __test__.normalizePayload(
      JSON.stringify({
        agent_id: 'Unknown',
        role: 'Assistant',
        kind: 'run-started',
        content: 'release started',
        attrs: {
          swarmAgentIdentity: 'marco-silva-jangar-deployer',
          swarmAgentRole: 'deployer',
          swarmHumanName: 'Marco Silva',
        },
      }),
      'agents.agent_messages.general.run-started',
    )

    expect(message?.agentId).toBe('Unknown')
    expect(message?.role).toBe('Assistant')
    expect(message?.attrs?.swarmHumanName).toBe('Marco Silva')
  })
})
