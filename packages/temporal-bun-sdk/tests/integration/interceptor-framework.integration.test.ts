import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { Effect, Exit } from 'effect'

import { createTemporalClient, type TemporalClient } from '../../src/client'
import { loadTemporalConfig } from '../../src/config'
import { type TemporalInterceptor } from '../../src/interceptors/types'
import { WorkerRuntime } from '../../src/worker/runtime'
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

describeIntegration('interceptor framework wiring', () => {
  let harness: IntegrationHarness | null = null
  let runtime: WorkerRuntime | null = null
  let runtimePromise: Promise<void> | null = null
  let client: TemporalClient | null = null
  let cliUnavailable = false

  const clientEvents: string[] = []
  const workerEvents: string[] = []

  const captureClientInterceptor: TemporalInterceptor = {
    name: 'capture-client',
    outbound: (ctx, next) =>
      Effect.sync(() => {
        clientEvents.push(`${ctx.kind}:out`)
      }).pipe(Effect.flatMap(() => next())),
    inbound: (ctx, next) =>
      Effect.sync(() => {
        clientEvents.push(`${ctx.kind}:in`)
      }).pipe(Effect.flatMap(() => next())),
  }

  const captureWorkerInterceptor: TemporalInterceptor = {
    name: 'capture-worker',
    outbound: (ctx, next) =>
      Effect.sync(() => {
        workerEvents.push(`${ctx.kind}:out`)
      }).pipe(Effect.flatMap(() => next())),
    inbound: (ctx, next) =>
      Effect.sync(() => {
        workerEvents.push(`${ctx.kind}:in`)
      }).pipe(Effect.flatMap(() => next())),
  }

  beforeAll(async () => {
    const harnessExit = await Effect.runPromiseExit(createIntegrationHarness(CLI_CONFIG))
    if (Exit.isFailure(harnessExit)) {
      if (harnessExit.cause instanceof TemporalCliUnavailableError) {
        cliUnavailable = true
        console.warn(`[temporal-bun-sdk] skipping interceptor integration: ${harnessExit.cause.message}`)
        return
      }
      throw harnessExit.cause
    }
    harness = harnessExit.value
    await Effect.runPromise(harness.setup)

    const baseConfig = await loadTemporalConfig({
      defaults: {
        address: CLI_CONFIG.address,
        namespace: CLI_CONFIG.namespace,
        taskQueue: CLI_CONFIG.taskQueue,
      },
    })

    runtime = await WorkerRuntime.create({
      config: baseConfig,
      workflows: integrationWorkflows,
      activities: integrationActivities,
      taskQueue: CLI_CONFIG.taskQueue,
      namespace: CLI_CONFIG.namespace,
      interceptors: [captureWorkerInterceptor],
    })
    runtimePromise = runtime.run()

    const clientHandles = await createTemporalClient({
      config: baseConfig,
      clientInterceptors: [captureClientInterceptor],
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
      console.warn(`[temporal-bun-sdk] interceptor scenario skipped (${name})`)
      return undefined
    }
    if (!harness || !client) {
      throw new Error('Integration harness not initialised')
    }
    try {
      return await Effect.runPromise(
        harness.runScenario(name, () => Effect.tryPromise(fn)),
      )
    } catch (error) {
      if (error instanceof TemporalCliUnavailableError) {
        cliUnavailable = true
        console.warn(`[temporal-bun-sdk] interceptor scenario skipped (${name}): ${error.message}`)
        return undefined
      }
      throw error
    }
  }

  test('fires hooks for start, signal, query, update, and activity paths', async () => {
    await runOrSkip('start-signal-query-update', async () => {
      clientEvents.length = 0
      workerEvents.length = 0

      await client!.startWorkflow({
        workflowType: 'integrationActivityWorkflow',
        workflowId: `int-activity-${crypto.randomUUID()}`,
        taskQueue: CLI_CONFIG.taskQueue,
        args: [{ value: 'ok' }],
      })

      const signalWorkflowHandle = await client!.startWorkflow({
        workflowType: 'integrationSignalQueryWorkflow',
        workflowId: `int-signal-${crypto.randomUUID()}`,
        taskQueue: CLI_CONFIG.taskQueue,
      })

      await client!.signalWorkflow(signalWorkflowHandle.handle, 'unblock', 'go')
      await client!.queryWorkflow(signalWorkflowHandle.handle, 'state', {})

      const updateWorkflowHandle = await client!.startWorkflow({
        workflowType: 'integrationUpdateWorkflow',
        workflowId: `int-update-${crypto.randomUUID()}`,
        taskQueue: CLI_CONFIG.taskQueue,
        args: [{ initialMessage: 'boot' }],
      })

      await client!.updateWorkflow(updateWorkflowHandle.handle, {
        updateName: 'integrationUpdate.setMessage',
        args: [{ value: 'patched' }],
        waitForStage: 'completed',
      })

      expect(clientEvents.some((entry) => entry.startsWith('workflow.start'))).toBeTrue()
      expect(clientEvents.some((entry) => entry.startsWith('workflow.signal'))).toBeTrue()
      expect(clientEvents.some((entry) => entry.startsWith('workflow.query'))).toBeTrue()
      expect(clientEvents.some((entry) => entry.startsWith('workflow.update'))).toBeTrue()

      expect(workerEvents.some((entry) => entry.startsWith('worker.activityTask'))).toBeTrue()
      expect(workerEvents.some((entry) => entry.startsWith('worker.workflowTask'))).toBeTrue()
      expect(workerEvents.some((entry) => entry.startsWith('worker.queryTask'))).toBeTrue()
      expect(workerEvents.some((entry) => entry.startsWith('worker.updateTask'))).toBeTrue()
    })
  })
})
