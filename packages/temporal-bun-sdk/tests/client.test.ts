import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { TemporalConfig } from '../src/config'
import { importNativeBridge } from './helpers/native-bridge'

const { module: nativeModule, stubPath } = await importNativeBridge()

let createTemporalClient: any
let NativeBridgeError: any
let native: any
let computeSignalRequestId: any

if (nativeModule && stubPath) {
  const clientModule = await import('../src/client')
  createTemporalClient = clientModule.createTemporalClient
  NativeBridgeError = nativeModule.NativeBridgeError
  native = nativeModule.native
  const serializationModule = await import('../src/client/serialization')
  computeSignalRequestId = serializationModule.computeSignalRequestId
}

const encodeJson = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

if (nativeModule && stubPath) {
  describe('temporal client (native bridge)', () => {
    const original = {
      createRuntime: native.createRuntime,
      runtimeShutdown: native.runtimeShutdown,
      createClient: native.createClient,
      clientShutdown: native.clientShutdown,
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
      native.terminateWorkflow = mock(async () => {})
      native.describeNamespace = mock(async () => new Uint8Array())
      native.updateClientHeaders = mock(() => {})
      native.signalWorkflow = mock(async () => {})
      native.queryWorkflow = mock(async () => encodeJson(null))
    })

    afterEach(() => {
      Object.assign(native, original)
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

      const expectedRequestId = computeSignalRequestId({
        namespace: 'analytics',
        workflowId: 'wf-signal',
        runId: 'run-current',
        firstExecutionRunId: 'run-initial',
        signalName: 'example-signal',
        identity: 'worker',
        args: [{ foo: 'bar' }, 123],
      })

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
      await client.shutdown()
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

    test('updateHeaders normalizes keys and values then forwards to native', async () => {
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

      await client.updateHeaders({ Authorization: 'Bearer token-123  ', 'X-Custom': '  value ' })

      expect(native.updateClientHeaders).toHaveBeenCalledWith(clientHandle, {
        authorization: 'Bearer token-123',
        'x-custom': 'value',
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

    test('queryWorkflow applies defaults and parses JSON response', async () => {
      let capturedRequest: Record<string, unknown> | undefined
      native.queryWorkflow = mock(async (_handle, request: Record<string, unknown>) => {
        capturedRequest = request
        return encodeJson({ state: 'running', count: 2 })
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
        return encodeJson('ok')
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
