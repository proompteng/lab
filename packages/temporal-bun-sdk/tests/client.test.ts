import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { TemporalConfig } from '../src/config'

const ensureNativeBridgeStub = () => {
  const rootDir = fileURLToPath(new URL('..', import.meta.url))
  const targetDir = join(rootDir, 'native/temporal-bun-bridge/target')
  let binaryName: string
  if (process.platform === 'win32') {
    binaryName = 'temporal_bun_bridge.dll'
  } else if (process.platform === 'darwin') {
    binaryName = 'libtemporal_bun_bridge.dylib'
  } else {
    binaryName = 'libtemporal_bun_bridge.so'
  }
  const binaryPath = join(targetDir, 'debug', binaryName)

  if (existsSync(binaryPath)) {
    return binaryPath
  }

  const fixturesDir = join(rootDir, 'tests/fixtures')
  const stubSource = join(fixturesDir, 'stub_temporal_bridge.c')
  mkdirSync(join(targetDir, 'debug'), { recursive: true })

  const compilerArgs: string[] = []
  if (process.platform === 'darwin') {
    compilerArgs.push('-dynamiclib')
  } else if (process.platform === 'win32') {
    compilerArgs.push('-shared')
  } else {
    compilerArgs.push('-shared', '-fPIC')
  }
  compilerArgs.push(stubSource, '-o', binaryPath)

  const result = spawnSync('cc', compilerArgs, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error('Failed to compile Temporal bridge stub for tests')
  }

  return binaryPath
}

ensureNativeBridgeStub()

const { createTemporalClient } = await import('../src/client')
const { NativeBridgeError, native } = await import('../src/internal/core-bridge/native')

const encodeJson = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

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

  test('startWorkflow maps optional fields into the bridge payload', async () => {
    let captured: Record<string, unknown> | undefined
    native.startWorkflow = mock(async (_: unknown, payload: Record<string, unknown>) => {
      captured = payload
      return encodeJson({ runId: 'run-opt', workflowId: payload.workflow_id, namespace: payload.namespace })
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

    await client.workflow.start({
      workflowId: 'wf-opt',
      workflowType: 'ExampleWorkflow',
      namespace: 'custom-namespace',
      taskQueue: 'custom-queue',
      identity: 'explicit-worker',
      cronSchedule: '@hourly',
      memo: { feature: 'beta' },
      headers: { 'x-trace-id': '123' },
      searchAttributes: { CustomerId: ['abc-123'] },
      requestId: 'request-42',
      workflowExecutionTimeoutMs: 60_000,
      workflowRunTimeoutMs: 30_000,
      workflowTaskTimeoutMs: 10_000,
      retryPolicy: {
        maximumAttempts: 3,
      },
    })

    expect(captured).toMatchObject({
      namespace: 'custom-namespace',
      workflow_id: 'wf-opt',
      workflow_type: 'ExampleWorkflow',
      task_queue: 'custom-queue',
      identity: 'explicit-worker',
      cron_schedule: '@hourly',
      memo: { feature: 'beta' },
      headers: { 'x-trace-id': '123' },
      search_attributes: { CustomerId: ['abc-123'] },
      request_id: 'request-42',
      workflow_execution_timeout_ms: 60_000,
      workflow_run_timeout_ms: 30_000,
      workflow_task_timeout_ms: 10_000,
      retry_policy: {
        maximum_attempts: 3,
      },
    })
    expect(captured?.args).toEqual([])

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
})
