import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { PayloadCodec } from '@temporalio/common'
import { temporal } from '@temporalio/proto'
import type { TemporalConfig } from '../src/config'
import {
  PAYLOAD_TUNNEL_FIELD,
  createDataConverter,
  encodeValuesToPayloads,
  jsonToPayload,
  payloadToJson,
} from '../src/common/payloads'
import { importNativeBridge } from './helpers/native-bridge'

const { module: nativeModule, stubPath } = await importNativeBridge()

let createTemporalClient: any
let NativeBridgeError: any
let native: any
let computeSignalRequestId: any
let serializationModule: any

if (nativeModule && stubPath) {
  const clientModule = await import('../src/client')
  createTemporalClient = clientModule.createTemporalClient
  NativeBridgeError = nativeModule.NativeBridgeError
  native = nativeModule.native
  serializationModule = await import('../src/client/serialization')
  computeSignalRequestId = serializationModule.computeSignalRequestId
}

const encodeJson = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

const encodeQueryResponse = (value: unknown): Uint8Array => {
  const encoder = new TextEncoder()
  const payload = {
    metadata: {
      encoding: encoder.encode('json/plain'),
    },
    data: encoder.encode(JSON.stringify(value ?? null)),
  }

  const response = temporal.api.workflowservice.v1.QueryWorkflowResponse.create({
    queryResult: { payloads: [payload] },
  })

  return temporal.api.workflowservice.v1.QueryWorkflowResponse.encode(response).finish()
}

const encodeQueryRejection = (): Uint8Array => {
  const response = temporal.api.workflowservice.v1.QueryWorkflowResponse.create({
    queryRejected: {
      status: temporal.api.enums.v1.WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_TERMINATED,
    },
  })
  return temporal.api.workflowservice.v1.QueryWorkflowResponse.encode(response).finish()
}

class JsonEnvelopeCodec implements PayloadCodec {
  readonly #encoder = new TextEncoder()
  readonly #decoder = new TextDecoder()

  async encode(payloads: ReturnType<typeof jsonToPayload>[]): Promise<ReturnType<typeof jsonToPayload>[]> {
    return payloads.map((payload) => {
      const serialized = JSON.stringify(payloadToJson(payload))
      return {
        metadata: { encoding: this.#encoder.encode('binary/custom') },
        data: this.#encoder.encode(serialized),
      }
    })
  }

  async decode(payloads: ReturnType<typeof jsonToPayload>[]): Promise<ReturnType<typeof jsonToPayload>[]> {
    return payloads.map((payload) => {
      const encoding = payload.metadata?.encoding ? this.#decoder.decode(payload.metadata.encoding) : undefined
      if (encoding !== 'binary/custom') {
        return payload
      }
      const raw = this.#decoder.decode(payload.data ?? new Uint8Array(0))
      const value = raw.length === 0 ? null : JSON.parse(raw)
      return jsonToPayload(value)
    })
  }
}

if (nativeModule && stubPath) {
  describe('temporal client (native bridge)', () => {
    const original = {
      createRuntime: native.createRuntime,
      runtimeShutdown: native.runtimeShutdown,
      createClient: native.createClient,
      clientShutdown: native.clientShutdown,
      configureTelemetry: native.configureTelemetry,
      startWorkflow: native.startWorkflow,
      terminateWorkflow: native.terminateWorkflow,
      describeNamespace: native.describeNamespace,
      updateClientHeaders: native.updateClientHeaders,
      signalWithStart: native.signalWithStart,
      signalWorkflow: native.signalWorkflow,
      queryWorkflow: native.queryWorkflow,
    }

    const runtimeHandle = { type: 'runtime', handle: 101 } as const
    const clientHandle = { type: 'client', handle: 202 } as const

    beforeEach(() => {
      native.createRuntime = mock(() => runtimeHandle)
      native.createClient = mock(async () => clientHandle)
      native.clientShutdown = mock(() => {})
      native.runtimeShutdown = mock(() => {})
      native.configureTelemetry = mock(() => {})
      native.terminateWorkflow = mock(async () => {})
      native.describeNamespace = mock(async () => new Uint8Array())
      native.updateClientHeaders = mock(() => {})
      native.signalWorkflow = mock(async () => {})
      native.queryWorkflow = mock(async () => encodeQueryResponse(null))
    })

    afterEach(() => {
      Object.assign(native, original)
      serializationModule.__setSignalRequestEntropyGeneratorForTests()
      native.configureTelemetry = original.configureTelemetry
    })

    test('startWorkflow forwards defaults and returns workflow handle metadata', async () => {
      const startWorkflowMock = mock(async (_: unknown, payload: Record<string, unknown>) => {
        expect(payload.workflow_id).toBe('workflow-123')
        expect(payload.workflow_type).toBe('ExampleWorkflow')
        expect(payload.namespace).toBe('analytics')
        expect(payload.task_queue).toBe('prix')
        expect(payload.identity).toBe('bun-worker-01')
        expect(payload.args).toEqual(['hello', 42])
        return encodeJson({
          runId: 'run-xyz',
          workflowId: payload.workflow_id,
          namespace: payload.namespace,
          firstExecutionRunId: 'run-root',
        })
      })

      native.startWorkflow = startWorkflowMock

      const config: TemporalConfig = {
        host: '127.0.0.1',
        port: 7233,
        address: '127.0.0.1:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'bun-worker-01',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({
        config,
        namespace: 'analytics',
      })

      const result = await client.workflow.start({
        workflowId: 'workflow-123',
        workflowType: 'ExampleWorkflow',
        args: ['hello', 42],
      })

      expect(result).toEqual({
        runId: 'run-xyz',
        workflowId: 'workflow-123',
        namespace: 'analytics',
        firstExecutionRunId: 'run-root',
        handle: {
          runId: 'run-xyz',
          workflowId: 'workflow-123',
          namespace: 'analytics',
          firstExecutionRunId: 'run-root',
        },
      })
      expect(startWorkflowMock).toHaveBeenCalledTimes(1)

      await client.shutdown()
      expect(native.clientShutdown).toHaveBeenCalledTimes(1)
      expect(native.runtimeShutdown).toHaveBeenCalledTimes(1)
    })

    test('configures runtime telemetry when provided', async () => {
      const config: TemporalConfig = {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker-telemetry',
        workerIdentityPrefix: 'temporal-bun-worker',
        telemetry: {
          logFilter: 'info',
          metricPrefix: 'bun-sdk',
          attachServiceName: true,
          metricsExporter: {
            type: 'prometheus',
            socketAddr: '127.0.0.1:9464',
            globalTags: { service: 'sdk' },
            histogramBucketOverrides: { latency: [1, 5, 10] },
          },
        },
      }

      const { client } = await createTemporalClient({ config })

      expect(native.configureTelemetry).toHaveBeenCalledTimes(1)
      expect(native.configureTelemetry).toHaveBeenCalledWith(runtimeHandle, {
        logExporter: { filter: 'info' },
        telemetry: { metricPrefix: 'bun-sdk', attachServiceName: true },
        metricsExporter: {
          type: 'prometheus',
          socketAddr: '127.0.0.1:9464',
          globalTags: { service: 'sdk' },
          histogramBucketOverrides: { latency: [1, 5, 10] },
        },
      })

      await client.shutdown()
    })

    test('startWorkflow builds retry policy payload', async () => {
      let captured: Record<string, unknown> | undefined
      native.startWorkflow = mock(async (_: unknown, payload: Record<string, unknown>) => {
        captured = payload
        return encodeJson({ runId: 'run-abc', workflowId: payload.workflow_id, namespace: payload.namespace })
      })

      const config: TemporalConfig = {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker-default',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({ config })

      const result = await client.startWorkflow({
        workflowId: 'wf-id',
        workflowType: 'Example',
        retryPolicy: {
          initialIntervalMs: 1_000,
          maximumIntervalMs: 10_000,
          maximumAttempts: 5,
          backoffCoefficient: 2,
          nonRetryableErrorTypes: ['FatalError'],
        },
      })

      expect(captured?.retry_policy).toEqual({
        initial_interval_ms: 1_000,
        maximum_interval_ms: 10_000,
        maximum_attempts: 5,
        backoff_coefficient: 2,
        non_retryable_error_types: ['FatalError'],
      })

      expect(result).toEqual({
        runId: 'run-abc',
        workflowId: 'wf-id',
        namespace: 'default',
        handle: {
          runId: 'run-abc',
          workflowId: 'wf-id',
          namespace: 'default',
        },
      })

      await client.shutdown()
    })

    test('signalWorkflow forwards payload to native bridge', async () => {
      const config: TemporalConfig = {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const captured: Record<string, unknown>[] = []
      native.signalWorkflow = mock(async (_client, payload: Record<string, unknown>) => {
        captured.push(payload)
      })

      const { client } = await createTemporalClient({ config })

      const entropy = 'test-signal-entropy'
      serializationModule.__setSignalRequestEntropyGeneratorForTests(() => entropy)

      try {
        await client.workflow.signal(
          {
            workflowId: 'wf-signal',
            namespace: 'analytics',
            runId: 'run-current',
            firstExecutionRunId: 'run-initial',
          },
          'example-signal',
          { foo: 'bar' },
          123,
        )

        const expectedRequestId = await computeSignalRequestId(
          {
            namespace: 'analytics',
            workflowId: 'wf-signal',
            runId: 'run-current',
            firstExecutionRunId: 'run-initial',
            signalName: 'example-signal',
            identity: 'worker',
            args: [{ foo: 'bar' }, 123],
          },
          client.dataConverter,
          { entropy },
        )

        expect(captured).toEqual([
          {
            namespace: 'analytics',
            workflow_id: 'wf-signal',
            run_id: 'run-current',
            first_execution_run_id: 'run-initial',
            signal_name: 'example-signal',
            args: [{ foo: 'bar' }, 123],
            identity: 'worker',
            request_id: expectedRequestId,
          },
        ])

        expect(native.signalWorkflow).toHaveBeenCalledTimes(1)
      } finally {
        serializationModule.__setSignalRequestEntropyGeneratorForTests()
        await client.shutdown()
      }
    })

    test('signalWorkflow surfaces native errors', async () => {
      const config: TemporalConfig = {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const failure = new Error('native signal failure')
      native.signalWorkflow = mock(async () => {
        throw failure
      })

      const { client } = await createTemporalClient({ config })

      await expect(
        client.workflow.signal(
          {
            workflowId: 'wf-missing',
            namespace: 'default',
          },
          'example-signal',
        ),
      ).rejects.toThrow('native signal failure')

    expect(native.signalWorkflow).toHaveBeenCalledTimes(1)
    await client.shutdown()
  })

    test('client uses custom data converter for signals and queries', async () => {
      const config: TemporalConfig = {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker-custom',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const converter = createDataConverter({ payloadCodecs: [new JsonEnvelopeCodec()] })
      const capturedSignals: Record<string, unknown>[] = []
      native.signalWorkflow = mock(async (_client, payload: Record<string, unknown>) => {
        capturedSignals.push(payload)
      })

      const encodedPayloads = await encodeValuesToPayloads(converter, ['custom-result'])
      native.queryWorkflow = mock(async () =>
        temporal.api.workflowservice.v1.QueryWorkflowResponse.encode({
          queryResult: { payloads: encodedPayloads ?? [] },
        }).finish(),
      )

      const { client } = await createTemporalClient({ config, dataConverter: converter })

      await client.workflow.signal({ workflowId: 'wf-custom', namespace: 'default' }, 'custom', new Uint8Array([10, 11]))

      expect(capturedSignals).toHaveLength(1)
      const [signalPayload] = capturedSignals
      const [firstArg] = (signalPayload.args ?? []) as unknown[]
      expect(firstArg && typeof firstArg === 'object').toBe(true)
      expect((firstArg as Record<string, unknown>)[PAYLOAD_TUNNEL_FIELD]).toBeDefined()

      const queryResult = await client.workflow.query({ workflowId: 'wf-custom' }, 'customQuery')
      expect(queryResult).toBe('custom-result')

      await client.shutdown()
    })

    test('terminateWorkflow forwards handle defaults and options to native bridge', async () => {
      const terminateMock = mock(async (_: unknown, payload: Record<string, unknown>) => {
        expect(payload).toEqual({
          namespace: 'analytics',
          workflow_id: 'workflow-terminate',
          run_id: 'run-current',
          first_execution_run_id: 'run-initial',
          reason: 'finished',
          details: ['cleanup', { ok: true }],
        })
      })
      native.terminateWorkflow = terminateMock

      const config: TemporalConfig = {
        host: '127.0.0.1',
        port: 7233,
        address: '127.0.0.1:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({ config, namespace: 'analytics' })

      await client.workflow.terminate(
        {
          workflowId: 'workflow-terminate',
          namespace: 'analytics',
          runId: 'run-current',
          firstExecutionRunId: 'run-initial',
        },
        {
          reason: 'finished',
          details: ['cleanup', { ok: true }],
        },
      )

      expect(terminateMock).toHaveBeenCalledTimes(1)
      await client.shutdown()
    })

    test('terminateWorkflow surfaces native errors', async () => {
      const failure = new Error('native terminate failed')
      native.terminateWorkflow = mock(async () => {
        throw failure
      })

      const config: TemporalConfig = {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({ config })

      await expect(
        client.workflow.terminate(
          {
            workflowId: 'terminate-error',
            namespace: 'default',
          },
          {},
        ),
      ).rejects.toThrow('native terminate failed')

      expect(native.terminateWorkflow).toHaveBeenCalledTimes(1)
      await client.shutdown()
    })

    test('createTemporalClient forwards TLS and API key options to native bridge', async () => {
      native.startWorkflow = mock(async (_: unknown, payload: Record<string, unknown>) => {
        return encodeJson({ runId: 'run-123', workflowId: payload.workflow_id, namespace: payload.namespace })
      })

      const config: TemporalConfig = {
        host: 'temporal.internal',
        port: 7233,
        address: 'temporal.internal:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: 'test-key',
        allowInsecureTls: false,
        workerIdentity: 'bun-worker',
        workerIdentityPrefix: 'temporal-bun-worker',
        tls: {
          serverRootCACertificate: Buffer.from('ROOT'),
          serverNameOverride: 'temporal.example.internal',
          clientCertPair: {
            crt: Buffer.from('CERT'),
            key: Buffer.from('KEY'),
          },
        },
      }

      await createTemporalClient({ config })

      expect(native.createClient).toHaveBeenLastCalledWith(runtimeHandle, {
        address: 'https://temporal.internal:7233',
        namespace: 'default',
        identity: 'bun-worker',
        apiKey: 'test-key',
        tls: {
          serverRootCACertificate: Buffer.from('ROOT').toString('base64'),
          server_root_ca_cert: Buffer.from('ROOT').toString('base64'),
          clientCertPair: {
            crt: Buffer.from('CERT').toString('base64'),
            key: Buffer.from('KEY').toString('base64'),
          },
          client_cert_pair: {
            crt: Buffer.from('CERT').toString('base64'),
            key: Buffer.from('KEY').toString('base64'),
          },
          client_cert: Buffer.from('CERT').toString('base64'),
          client_private_key: Buffer.from('KEY').toString('base64'),
          serverNameOverride: 'temporal.example.internal',
          server_name_override: 'temporal.example.internal',
        },
      })
    })

    test('updateHeaders serializes ASCII and binary metadata before forwarding to native', async () => {
      const config: TemporalConfig = {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker-default',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({ config })

      const traceBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])

      await client.updateHeaders({
        Authorization: 'Bearer token-123  ',
        'User-Agent': ' temporal-bun-sdk/1.0 ',
        'X-Trace-Bin': traceBytes,
        'x-json-bin': ' {"hello":"world"} ',
      })

      expect(native.updateClientHeaders).toHaveBeenCalledWith(clientHandle, {
        authorization: 'Bearer token-123',
        'user-agent': 'temporal-bun-sdk/1.0',
        'x-trace-bin': Buffer.from(traceBytes).toString('base64'),
        'x-json-bin': Buffer.from('{"hello":"world"}', 'utf8').toString('base64'),
      })

      await client.shutdown()
    })

    test('updateHeaders rejects duplicate or empty header keys', async () => {
      const config: TemporalConfig = {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker-default',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({ config })

      await expect(client.updateHeaders({ '': 'value' })).rejects.toThrow('Header keys must be non-empty strings')
      await expect(client.updateHeaders({ Foo: 'one', foo: 'two' })).rejects.toThrow(
        "Header key 'foo' is duplicated (case-insensitive match)",
      )

      await client.shutdown()
    })

    test('updateHeaders throws after shutdown and forwards native errors', async () => {
      const config: TemporalConfig = {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker-default',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({ config })

      native.updateClientHeaders = mock(() => {
        throw new NativeBridgeError('native failure')
      })

      await expect(client.updateHeaders({ authorization: 'Bearer rotate' })).rejects.toThrow('native failure')

      await client.shutdown()

      await expect(client.updateHeaders({ authorization: 'Bearer rotate' })).rejects.toThrow(
        'Temporal client has already been shut down',
      )
    })

    test('updateHeaders rejects non-ASCII characters for ASCII headers', async () => {
      const config: TemporalConfig = {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker-default',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({ config })

      await expect(client.updateHeaders({ Authorization: 'Béârér token' })).rejects.toThrow(
        "Header 'authorization' values must contain printable ASCII characters; use '-bin' for binary metadata",
      )

      await client.shutdown()
    })

    test('updateHeaders rejects binary payloads on non -bin headers', async () => {
      const config: TemporalConfig = {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker-default',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({ config })

      await expect(client.updateHeaders({ Authorization: new Uint8Array([0xde, 0xad]) })).rejects.toThrow(
        "Header 'authorization' accepts string values only; append '-bin' to use binary metadata",
      )

      await client.shutdown()
    })

    test('updateHeaders enforces non-empty binary payloads', async () => {
      const config: TemporalConfig = {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker-default',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({ config })

      await expect(client.updateHeaders({ 'x-trace-bin': new ArrayBuffer(0) })).rejects.toThrow(
        'Header values must be non-empty byte arrays',
      )

      await client.shutdown()
    })

    test('queryWorkflow applies defaults and parses JSON response', async () => {
      let capturedRequest: Record<string, unknown> | undefined
      native.queryWorkflow = mock(async (_handle, request: Record<string, unknown>) => {
        capturedRequest = request
        return encodeQueryResponse({ state: 'running', count: 2 })
      })

      const config: TemporalConfig = {
        host: '127.0.0.1',
        port: 7233,
        address: '127.0.0.1:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'bun-worker',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({ config })

      const result = await client.workflow.query({ workflowId: 'wf-99' }, 'currentState', { includeDetails: true })

      expect(result).toEqual({ state: 'running', count: 2 })
      expect(capturedRequest).toEqual({
        namespace: 'default',
        workflow_id: 'wf-99',
        query_name: 'currentState',
        args: [{ includeDetails: true }],
      })

      await client.shutdown()
    })

    test('queryWorkflow respects handle overrides and forwards runId', async () => {
      let capturedRequest: Record<string, unknown> | undefined
      native.queryWorkflow = mock(async (_handle, request: Record<string, unknown>) => {
        capturedRequest = request
        return encodeQueryResponse('ok')
      })

      const config: TemporalConfig = {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker-default',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({ config })

      const result = await client.workflow.query(
        { workflowId: 'wf-run', namespace: 'analytics', runId: 'run-123' },
        'inspect',
        'arg-1',
        42,
      )

      expect(result).toBe('ok')
      expect(capturedRequest).toEqual({
        namespace: 'analytics',
        workflow_id: 'wf-run',
        query_name: 'inspect',
        run_id: 'run-123',
        args: ['arg-1', 42],
      })

      await client.shutdown()
    })

    test('queryWorkflow surfaces query rejections from the server', async () => {
      native.queryWorkflow = mock(async () => encodeQueryRejection())

      const config: TemporalConfig = {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker-reject',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({ config })

      await expect(client.workflow.query({ workflowId: 'wf-reject' }, 'inspect')).rejects.toBeInstanceOf(NativeBridgeError)

      await client.shutdown()
    })

    test('queryWorkflow surfaces native errors', async () => {
      native.queryWorkflow = mock(async () => {
        throw new Error('query failure')
      })

      const config: TemporalConfig = {
        host: 'temporal',
        port: 7233,
        address: 'temporal:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'bun-worker',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({ config })

      await expect(client.workflow.query({ workflowId: 'wf-err' }, 'snapshot')).rejects.toThrow('query failure')

      await client.shutdown()
    })

    test('signalWithStart merges defaults and forwards payload to native', async () => {
      let captured: Record<string, unknown> | undefined
      native.signalWithStart = mock(async (_: unknown, payload: Record<string, unknown>) => {
        captured = payload
        return encodeJson({ runId: 'run-sws', workflowId: payload.workflow_id, namespace: payload.namespace })
      })

      const config: TemporalConfig = {
        host: '127.0.0.1',
        port: 7233,
        address: '127.0.0.1:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'bun-worker',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({ config, namespace: 'analytics' })

      const result = await client.signalWithStart({
        workflowId: 'wf-sws',
        workflowType: 'ExampleWorkflow',
        args: ['init'],
        signalName: 'kickoff',
        signalArgs: [{ ok: true }, 7],
      })

      expect(captured).toMatchObject({
        namespace: 'analytics',
        workflow_id: 'wf-sws',
        workflow_type: 'ExampleWorkflow',
        task_queue: 'prix',
        identity: 'bun-worker',
        args: ['init'],
        signal_name: 'kickoff',
        signal_args: [{ ok: true }, 7],
      })

      expect(result).toEqual({
        runId: 'run-sws',
        workflowId: 'wf-sws',
        namespace: 'analytics',
        handle: {
          runId: 'run-sws',
          workflowId: 'wf-sws',
          namespace: 'analytics',
        },
      })

      await client.shutdown()
    })

    test('signalWithStart surfaces native errors', async () => {
      native.signalWithStart = mock(async () => {
        throw new Error('sws failure')
      })

      const config: TemporalConfig = {
        host: 'localhost',
        port: 7233,
        address: 'localhost:7233',
        namespace: 'default',
        taskQueue: 'prix',
        apiKey: undefined,
        tls: undefined,
        allowInsecureTls: false,
        workerIdentity: 'worker',
        workerIdentityPrefix: 'temporal-bun-worker',
      }

      const { client } = await createTemporalClient({ config })

      await expect(
        client.signalWithStart({
          workflowId: 'wf-err',
          workflowType: 'WF',
          signalName: 'go',
        }),
      ).rejects.toThrow('sws failure')

      await client.shutdown()
    })
  })
} else {
  describe('temporal client (native bridge)', () => {
    test('skipped - C compiler not available', () => {
      console.warn('Skipping client tests - C compiler not available for native bridge stub compilation')
    })
  })
}
