import type { JsMsg, StringCodec } from 'nats'
import { describe, expect, it, vi } from 'vitest'

import { __test__ } from '~/server/agent-comms-subscriber'
import { publishAgentMessages } from '~/server/agent-messages-bus'
import { recordAgentCommsBatch, recordAgentCommsError } from '~/server/metrics'

vi.mock('~/server/agent-messages-bus', () => ({
  publishAgentMessages: vi.fn(),
}))

vi.mock('~/server/metrics', () => ({
  recordAgentCommsBatch: vi.fn(),
  recordAgentCommsError: vi.fn(),
}))

type StringCodecValue = ReturnType<typeof StringCodec>

const toBytes = (value: string) => new TextEncoder().encode(value)

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
  }) as AsyncIterable<JsMsg> & { stop: () => void; close: () => Promise<undefined | Error> }

describe('agent comms subscriber consume', () => {
  it('acks messages after insert and records batch metrics', async () => {
    const recordBatch = vi.mocked(recordAgentCommsBatch)
    const sc = { decode: (data: Uint8Array) => new TextDecoder().decode(data) } as StringCodecValue
    const insertMessages = vi.fn(async (inputs: unknown[]) =>
      inputs.map((input, index) => ({ ...(input as Record<string, unknown>), id: `msg-${index}`, createdAt: null })),
    )
    const store = { insertMessages, close: vi.fn(async () => {}) }
    const abortController = new AbortController()
    const config = { pullBatchSize: 2, pullExpiresMs: 0 } as Parameters<typeof __test__.consumeStream>[3]

    const subject = 'workflow.agents.demo.abc.agent.codex.message'
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
    const sc = { decode: (data: Uint8Array) => new TextDecoder().decode(data) } as StringCodecValue
    const insertMessages = vi.fn(async (inputs: unknown[]) =>
      inputs.map((input, index) => ({ ...(input as Record<string, unknown>), id: `msg-${index}`, createdAt: null })),
    )
    const store = { insertMessages, close: vi.fn(async () => {}) }
    const abortController = new AbortController()
    const config = { pullBatchSize: 1, pullExpiresMs: 0 } as Parameters<typeof __test__.consumeStream>[3]

    const subject = 'workflow.agents.demo.abc.agent.codex.message'
    const badMsg = createMessage({ role: 'assistant' }, subject)
    const goodMsg = createMessage({ content: 'ok' }, subject)

    await __test__.consumeStream(createStream([badMsg, goodMsg]), sc, store, config, abortController.signal)

    expect(badMsg.ack).toHaveBeenCalledTimes(1)
    expect(recordError.mock.calls[0][0]).toBe('decode')
    expect(goodMsg.ack).toHaveBeenCalledTimes(1)
    expect(insertMessages).toHaveBeenCalledTimes(1)
  })
})
