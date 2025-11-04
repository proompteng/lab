import { describe, expect, test } from 'bun:test'
import type { PayloadCodec } from '@temporalio/common'

import {
  createDataConverter,
  createDefaultDataConverter,
  decodePayloadsToValues,
  jsonToPayload,
  PAYLOAD_TUNNEL_FIELD,
  payloadToJson,
} from '../common/payloads'
import {
  buildSignalRequest,
  buildSignalWithStartRequest,
  buildStartWorkflowRequest,
  buildTerminateRequest,
  computeSignalRequestId,
} from './serialization'

const defaultConverter = createDefaultDataConverter()

class JsonEnvelopeCodec implements PayloadCodec {
  readonly #encoder = new TextEncoder()
  readonly #decoder = new TextDecoder()

  async encode(payloads: ReturnType<typeof jsonToPayload>[]): Promise<ReturnType<typeof jsonToPayload>[]> {
    return payloads.map((payload) => {
      const jsonValue = payloadToJson(payload)
      const text = this.#encoder.encode(JSON.stringify(jsonValue))
      return {
        metadata: {
          encoding: this.#encoder.encode('binary/custom'),
        },
        data: text,
      }
    })
  }

  async decode(payloads: ReturnType<typeof jsonToPayload>[]): Promise<ReturnType<typeof jsonToPayload>[]> {
    return payloads.map((payload) => {
      const raw = this.#decoder.decode(payload.data ?? new Uint8Array(0))
      const value = raw.length === 0 ? null : JSON.parse(raw)
      return jsonToPayload(value)
    })
  }
}

describe('buildSignalRequest', () => {
  test('builds a signal payload with workflow execution metadata', async () => {
    const payload = await buildSignalRequest(
      {
        handle: {
          workflowId: 'wf-id',
          namespace: 'default',
          runId: 'run-id',
          firstExecutionRunId: 'first-run-id',
        },
        signalName: 'signalName',
        args: [{ foo: 'bar' }],
        identity: 'sig-client',
        requestId: 'req-123',
      },
      defaultConverter,
    )

    expect(payload.namespace).toBe('default')
    expect(payload.workflowExecution?.workflowId).toBe('wf-id')
    expect(payload.workflowExecution?.runId).toBe('run-id')
    expect(payload.identity).toBe('sig-client')
    expect(payload.requestId).toBe('req-123')

    const values = await decodePayloadsToValues(defaultConverter, payload.input?.payloads ?? [])
    expect(values).toEqual([{ foo: 'bar' }])
  })

  test('decodes payload codec tunnelled values', async () => {
    const converter = createDataConverter({ payloadCodecs: [new JsonEnvelopeCodec()] })
    const payload = await buildSignalRequest(
      {
        handle: { workflowId: 'wf-id', namespace: 'default' },
        signalName: 'signalName',
        args: [new Uint8Array([1, 2, 3])],
      },
      converter,
    )

    const [first] = payload.input?.payloads ?? []
    expect(first).toBeDefined()
    const decoded = await decodePayloadsToValues(converter, payload.input?.payloads ?? [])
    expect(decoded[0] && typeof decoded[0] === 'object').toBe(true)
    expect(Object.keys(first?.metadata ?? {})).not.toHaveLength(0)
    const jsonValue = payloadToJson(jsonToPayload(decoded[0])) as Record<string, unknown>
    expect(jsonValue[PAYLOAD_TUNNEL_FIELD]).toBeDefined()
  })
})

describe('computeSignalRequestId', () => {
  test('is deterministic for identical payloads when entropy is reused and insensitive to object key order', async () => {
    const base = {
      namespace: 'default',
      workflowId: 'wf-id',
      runId: 'run-001',
      firstExecutionRunId: 'root-123',
      signalName: 'signalName',
      identity: 'sig-client',
    }

    const entropy = 'stable-entropy'
    const first = await computeSignalRequestId({ ...base, args: [{ foo: 'bar', baz: 1 }] }, defaultConverter, {
      entropy,
    })
    const second = await computeSignalRequestId({ ...base, args: [{ baz: 1, foo: 'bar' }] }, defaultConverter, {
      entropy,
    })

    expect(first).toBe(second)
  })

  test('generates unique IDs for identical payloads when entropy differs', async () => {
    const base = {
      namespace: 'default',
      workflowId: 'wf-id',
      signalName: 'signalName',
      args: [{ foo: 'bar' }],
    }

    const first = await computeSignalRequestId(base, defaultConverter, { entropy: 'entropy-a' })
    const second = await computeSignalRequestId(base, defaultConverter, { entropy: 'entropy-b' })

    expect(first).not.toBe(second)
  })
})

describe('buildSignalWithStartRequest', () => {
  test('merges defaults with signal payload', async () => {
    const request = await buildSignalWithStartRequest(
      {
        options: {
          workflowId: 'example-workflow',
          workflowType: 'ExampleWorkflow',
          signalName: 'example-signal',
          signalArgs: [{ hello: 'world' }, 42],
        },
        defaults: {
          namespace: 'default',
          identity: 'client-123',
          taskQueue: 'primary',
        },
      },
      defaultConverter,
    )

    expect(request.namespace).toBe('default')
    expect(request.workflowId).toBe('example-workflow')
    expect(request.workflowType?.name).toBe('ExampleWorkflow')
    expect(request.taskQueue?.name).toBe('primary')
    expect(request.identity).toBe('client-123')
    expect(request.signalName).toBe('example-signal')

    const values = await decodePayloadsToValues(defaultConverter, request.signalInput?.payloads ?? [])
    expect(values).toEqual([{ hello: 'world' }, 42])
  })
})

describe('buildStartWorkflowRequest', () => {
  test('applies optional fields using camelCase keys', async () => {
    const request = await buildStartWorkflowRequest(
      {
        options: {
          workflowId: 'wf-1',
          workflowType: 'ExampleWorkflow',
          args: ['foo'],
          namespace: 'custom',
          identity: 'custom-identity',
          taskQueue: 'custom-queue',
          cronSchedule: '* * * * *',
          memo: { note: 'hello' },
          headers: { headerKey: 'headerValue' },
          searchAttributes: { CustomIntField: 10 },
          requestId: 'req-123',
          workflowExecutionTimeoutMs: 60000,
          workflowRunTimeoutMs: 120000,
          workflowTaskTimeoutMs: 30000,
          retryPolicy: {
            initialIntervalMs: 1000,
            maximumIntervalMs: 10000,
            maximumAttempts: 5,
            backoffCoefficient: 2,
            nonRetryableErrorTypes: ['FatalError'],
          },
        },
        defaults: {
          namespace: 'default',
          identity: 'default-identity',
          taskQueue: 'primary',
        },
      },
      defaultConverter,
    )

    expect(request.namespace).toBe('custom')
    expect(request.workflowId).toBe('wf-1')
    expect(request.workflowType?.name).toBe('ExampleWorkflow')
    expect(request.taskQueue?.name).toBe('custom-queue')
    expect(request.identity).toBe('custom-identity')
    expect(request.cronSchedule).toBe('* * * * *')
    expect(request.requestId).toBe('req-123')
    expect(request.retryPolicy?.maximumAttempts).toBe(5)

    const args = await decodePayloadsToValues(defaultConverter, request.input?.payloads ?? [])
    expect(args).toEqual(['foo'])
  })

  test('falls back to defaults when optional fields omitted', async () => {
    const request = await buildStartWorkflowRequest(
      {
        options: {
          workflowId: 'wf-2',
          workflowType: 'ExampleWorkflow',
        },
        defaults: {
          namespace: 'default',
          identity: 'default-worker',
          taskQueue: 'primary',
        },
      },
      defaultConverter,
    )

    expect(request.namespace).toBe('default')
    expect(request.workflowId).toBe('wf-2')
    expect(request.workflowType?.name).toBe('ExampleWorkflow')
    expect(request.taskQueue?.name).toBe('primary')
    expect(request.identity).toBe('default-worker')
    const args = await decodePayloadsToValues(defaultConverter, request.input?.payloads ?? [])
    expect(args).toEqual([])
  })
})

describe('buildTerminateRequest', () => {
  test('encodes optional terminate details', async () => {
    const request = await buildTerminateRequest(
      { workflowId: 'wf', namespace: 'default' },
      { details: ['reason', { code: 42 }] },
      defaultConverter,
      'identity-123',
    )
    const details = await decodePayloadsToValues(defaultConverter, request.details?.payloads ?? [])
    expect(details).toEqual(['reason', { code: 42 }])
    expect(request.identity).toBe('identity-123')
  })
})
