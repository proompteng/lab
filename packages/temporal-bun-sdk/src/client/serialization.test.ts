import { describe, expect, test } from 'bun:test'
import type { PayloadCodec } from '@temporalio/common'

import {
  createDataConverter,
  createDefaultDataConverter,
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
  test('builds a payload with defaults from the workflow handle', async () => {
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

    expect(payload).toEqual({
      namespace: 'default',
      workflow_id: 'wf-id',
      run_id: 'run-id',
      first_execution_run_id: 'first-run-id',
      signal_name: 'signalName',
      args: [{ foo: 'bar' }],
      identity: 'sig-client',
      request_id: 'req-123',
    })
  })

  test('clones args array to avoid accidental mutation', async () => {
    const args = [{ foo: 'bar' }]
    const payload = await buildSignalRequest(
      {
        handle: {
          workflowId: 'wf-id',
          namespace: 'default',
        },
        signalName: 'signalName',
        args,
      },
      defaultConverter,
    )

    expect(payload.args).toEqual([{ foo: 'bar' }])
    expect(payload.args).not.toBe(args)
    ;(payload.args as unknown[])[0] = { foo: 'baz' }
    expect(args).toEqual([{ foo: 'bar' }])
  })

  test('validates required workflow and signal identifiers', async () => {
    await expect(
      buildSignalRequest(
        {
          handle: { workflowId: '', namespace: 'default' },
          signalName: 'signalName',
          args: [],
        },
        defaultConverter,
      ),
    ).rejects.toThrowError(/workflowId/)

    await expect(
      buildSignalRequest(
        {
          handle: { workflowId: 'wf-id' },
          signalName: 'signalName',
          args: [],
        },
        defaultConverter,
      ),
    ).rejects.toThrowError(/namespace/)

    await expect(
      buildSignalRequest(
        {
          handle: { workflowId: 'wf-id', namespace: 'default' },
          signalName: '',
          args: [],
        },
        defaultConverter,
      ),
    ).rejects.toThrowError(/signal name/)
  })

  test('encodes non-json payloads through codec tunnel', async () => {
    const converter = createDataConverter({ payloadCodecs: [new JsonEnvelopeCodec()] })
    const payload = await buildSignalRequest(
      {
        handle: { workflowId: 'wf-id', namespace: 'default' },
        signalName: 'signalName',
        args: [new Uint8Array([1, 2, 3])],
      },
      converter,
    )

    const [first] = payload.args as unknown[]
    expect(first && typeof first === 'object').toBe(true)
    expect((first as Record<string, unknown>)[PAYLOAD_TUNNEL_FIELD]).toBeDefined()
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

  test('respects toJSON implementations when hashing arguments', async () => {
    const base = {
      namespace: 'default',
      workflowId: 'wf-id',
      signalName: 'signalName',
      args: [],
    }

    const entropy = 'json-aware-entropy'
    const first = await computeSignalRequestId(
      { ...base, args: [new Date('2024-01-01T00:00:00.000Z')] },
      defaultConverter,
      { entropy },
    )
    const second = await computeSignalRequestId(
      { ...base, args: [new Date('2025-01-01T00:00:00.000Z')] },
      defaultConverter,
      { entropy },
    )

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

    expect(request).toEqual({
      namespace: 'default',
      workflow_id: 'example-workflow',
      workflow_type: 'ExampleWorkflow',
      task_queue: 'primary',
      identity: 'client-123',
      args: [],
      signal_name: 'example-signal',
      signal_args: [{ hello: 'world' }, 42],
    })
  })
})

describe('buildStartWorkflowRequest', () => {
  test('applies optional fields with snake_case keys', async () => {
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

    expect(request).toMatchObject({
      namespace: 'custom',
      workflow_id: 'wf-1',
      workflow_type: 'ExampleWorkflow',
      task_queue: 'custom-queue',
      identity: 'custom-identity',
      args: ['foo'],
      cron_schedule: '* * * * *',
      memo: { note: 'hello' },
      headers: { headerKey: 'headerValue' },
      search_attributes: { CustomIntField: 10 },
      request_id: 'req-123',
      workflow_execution_timeout_ms: 60000,
      workflow_run_timeout_ms: 120000,
      workflow_task_timeout_ms: 30000,
      retry_policy: {
        initial_interval_ms: 1000,
        maximum_interval_ms: 10000,
        maximum_attempts: 5,
        backoff_coefficient: 2,
        non_retryable_error_types: ['FatalError'],
      },
    })
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

    expect(request).toMatchObject({
      namespace: 'default',
      workflow_id: 'wf-2',
      workflow_type: 'ExampleWorkflow',
      task_queue: 'primary',
      identity: 'default-worker',
      args: [],
    })
  })
})

describe('buildTerminateRequest', () => {
  test('encodes optional terminate details', async () => {
    const request = await buildTerminateRequest(
      { workflowId: 'wf', namespace: 'default' },
      { details: ['reason', { code: 42 }] },
      defaultConverter,
    )
    expect(request.details).toEqual(['reason', { code: 42 }])
  })
})
