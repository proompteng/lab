import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { join } from 'node:path'
import { ConnectError, Code } from '@connectrpc/connect'
import { Effect, Exit } from 'effect'

import { createTemporalClient, type TemporalClient, TemporalTlsHandshakeError } from '../../src/client'
import { loadTemporalConfig } from '../../src/config'
import { WorkerRuntime } from '../../src/worker/runtime'
import type { TemporalInterceptor } from '../../src/client/interceptors'
import { TemporalCliUnavailableError, createIntegrationHarness, type IntegrationHarness } from './harness'
import { integrationActivities, integrationWorkflows } from './workflows'

const shouldRunIntegration = process.env.TEMPORAL_INTEGRATION_TESTS === '1'
const describeIntegration = shouldRunIntegration ? describe : describe.skip
const hookTimeoutMs = 60_000

const CLI_CONFIG = {
  address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'temporal-bun-integration',
}

describeIntegration('Temporal client resilience', () => {
  let harness: IntegrationHarness | null = null
  let runtime: WorkerRuntime | null = null
  let runtimePromise: Promise<void> | null = null
  let cliUnavailable = false
  let client: TemporalClient | null = null
  let baseConfig = null as Awaited<ReturnType<typeof loadTemporalConfig>> | null

  const failureBudgets = new Map<string, number>()

  const injectionInterceptor: TemporalInterceptor = (next) => async (req) => {
    const remaining = failureBudgets.get(req.method.name)
    if (remaining && remaining > 0) {
      failureBudgets.set(req.method.name, remaining - 1)
      throw new ConnectError(`injected-${req.method.name}`, Code.Unavailable)
    }
    return next(req)
  }

  beforeEach(() => {
    failureBudgets.clear()
  })

  beforeAll(async () => {
    const harnessExit = await Effect.runPromiseExit(createIntegrationHarness(CLI_CONFIG))
    if (Exit.isFailure(harnessExit)) {
      if (harnessExit.cause instanceof TemporalCliUnavailableError) {
        cliUnavailable = true
        console.warn(`[temporal-bun-sdk] skipping resilience integration: ${harnessExit.cause.message}`)
        return
      }
      throw harnessExit.cause
    }
    harness = harnessExit.value
    await Effect.runPromise(harness.setup)

    baseConfig = await loadTemporalConfig({
      defaults: {
        address: CLI_CONFIG.address,
        namespace: CLI_CONFIG.namespace,
        taskQueue: CLI_CONFIG.taskQueue,
      },
    })

    if (!baseConfig) {
      throw new Error('failed to load Temporal config for integration test')
    }

    runtime = await WorkerRuntime.create({
      config: baseConfig,
      workflows: integrationWorkflows,
      activities: integrationActivities,
      taskQueue: CLI_CONFIG.taskQueue,
      namespace: CLI_CONFIG.namespace,
      stickyScheduling: true,
      workflowGuards: 'warn',
    })
    runtimePromise = runtime.run()

    const clientHandles = await createTemporalClient({
      config: baseConfig,
      interceptors: [injectionInterceptor],
    })
    client = clientHandles.client
  }, { timeout: hookTimeoutMs })

  afterAll(async () => {
    if (client) {
      await client.shutdown()
    }
    if (runtime) {
      await runtime.shutdown()
    }
    if (runtimePromise) {
      await runtimePromise
    }
    if (harness && !cliUnavailable) {
      await Effect.runPromise(harness.teardown)
    }
  }, { timeout: hookTimeoutMs })

  const runOrSkip = async <A>(name: string, fn: () => Promise<A>): Promise<A | undefined> => {
    if (cliUnavailable) {
      console.warn(`[temporal-bun-sdk] resilience scenario skipped (${name})`)
      return undefined
    }
    if (!harness || !client || !baseConfig) {
      throw new Error('Integration harness not initialised')
    }
    try {
      return await Effect.runPromise(
        harness.runScenario(name, () => Effect.tryPromise(fn)),
      )
    } catch (error) {
      if (error instanceof TemporalCliUnavailableError) {
        cliUnavailable = true
        console.warn(`[temporal-bun-sdk] resilience scenario skipped (${name}): ${error.message}`)
        return undefined
      }
      throw error
    }
  }

  const startWorkflow = async (callOptions?: Parameters<TemporalClient['startWorkflow']>[1]) => {
    if (!client) throw new Error('client not initialised')
    return client.startWorkflow(
      {
        workflowType: 'integrationActivityWorkflow',
        workflowId: `resilience-${crypto.randomUUID()}`,
        taskQueue: CLI_CONFIG.taskQueue,
        args: [{ value: 'ok' }],
      },
      callOptions,
    )
  }

  test('retries transient WorkflowService failures', async () => {
    await runOrSkip('start-retry', async () => {
      failureBudgets.set('StartWorkflowExecution', 1)
      const result = await startWorkflow()
      expect(result.runId).toBeDefined()
      expect(failureBudgets.get('StartWorkflowExecution')).toBe(0)
    })
  })

  test('per-call retry overrides fail fast when attempt budget is low', async () => {
    await runOrSkip('start-override', async () => {
      failureBudgets.set('StartWorkflowExecution', 2)
      await expect(
        startWorkflow({ retryPolicy: { maxAttempts: 1 } }),
      ).rejects.toThrow('injected-StartWorkflowExecution')
    })
  })

  test('memo/search helpers are exposed via the client data converter', async () => {
    await runOrSkip('memo-helpers', async () => {
      if (!client) throw new Error('client not initialised')
      const memo = await client.memo.encode({ shard: 'a', index: 2 })
      const decodedMemo = await client.memo.decode(memo)
      expect(decodedMemo).toEqual({ shard: 'a', index: 2 })

      const search = await client.searchAttributes.encode({ region: 'iad', priority: 5 })
      const decodedSearch = await client.searchAttributes.decode(search)
      expect(decodedSearch).toEqual({ region: 'iad', priority: 5 })
    })
  })

  test('invalid TLS transport surfaces TemporalTlsHandshakeError', async () => {
    await runOrSkip('tls-handshake', async () => {
      const tlsConfig = await loadTemporalConfig({
        env: {
          TEMPORAL_ADDRESS: CLI_CONFIG.address,
          TEMPORAL_NAMESPACE: CLI_CONFIG.namespace,
          TEMPORAL_TLS_CA_PATH: join(import.meta.dir, '..', 'fixtures', 'tls', 'temporal-test-ca.pem'),
          TEMPORAL_TLS_CERT_PATH: join(import.meta.dir, '..', 'fixtures', 'tls', 'temporal-test-client.pem'),
          TEMPORAL_TLS_KEY_PATH: join(import.meta.dir, '..', 'fixtures', 'tls', 'temporal-test-client.key'),
        },
      })

      const { client: tlsClient } = await createTemporalClient({ config: tlsConfig })
      await expect(tlsClient.describeNamespace(CLI_CONFIG.namespace)).rejects.toThrow(
        'Temporal endpoint rejected TLS/HTTP2 handshakes',
      )
      await tlsClient.shutdown()
    })
  })
})
