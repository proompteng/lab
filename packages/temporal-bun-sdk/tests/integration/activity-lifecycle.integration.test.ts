import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'

import { Effect, Exit } from 'effect'

import { loadTemporalConfig } from '../../src/config'
import { WorkerRuntime } from '../../src/worker/runtime'
import { EventType } from '../../src/proto/temporal/api/enums/v1/event_type_pb'
import { TemporalCliCommandError, TemporalCliUnavailableError, createIntegrationHarness } from './harness'
import type { IntegrationHarness, WorkflowExecutionHandle } from './harness'
import { heartbeatWorkflow, heartbeatTimeoutWorkflow, integrationActivities, integrationWorkflows, retryProbeWorkflow } from './workflows'

const shouldRunIntegration = process.env.TEMPORAL_INTEGRATION_TESTS === '1'
const describeIntegration = shouldRunIntegration ? describe : describe.skip
const scenarioTimeoutMs = 60_000
const hookTimeoutMs = 60_000

const CLI_CONFIG = {
  address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'temporal-bun-integration',
}

describeIntegration('Activity lifecycle integration', () => {
  let harness: IntegrationHarness | null = null
  let runtime: WorkerRuntime | null = null
  let runtimePromise: Promise<void> | null = null
  let cliUnavailable = false

  beforeAll(async () => {
    const harnessExit = await Effect.runPromiseExit(createIntegrationHarness(CLI_CONFIG))
    if (Exit.isFailure(harnessExit)) {
      if (harnessExit.cause instanceof TemporalCliUnavailableError) {
        cliUnavailable = true
        console.warn(`[temporal-bun-sdk] skipping lifecycle integration: ${harnessExit.cause.message}`)
        return
      }
      throw harnessExit.cause
    }
    harness = harnessExit.value
    await Effect.runPromise(harness.setup)

    const runtimeConfig = await loadTemporalConfig({
      defaults: {
        address: CLI_CONFIG.address,
        namespace: CLI_CONFIG.namespace,
        taskQueue: CLI_CONFIG.taskQueue,
      },
    })

    runtime = await WorkerRuntime.create({
      config: runtimeConfig,
      workflows: integrationWorkflows,
      activities: integrationActivities,
      taskQueue: CLI_CONFIG.taskQueue,
      namespace: CLI_CONFIG.namespace,
      stickyScheduling: true,
    })
    runtimePromise = runtime.run()
  }, { timeout: hookTimeoutMs })

  afterAll(async () => {
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

  const runOrSkip = async <A>(name: string, scenario: () => Promise<A>): Promise<A | undefined> => {
    if (cliUnavailable) {
      console.warn(`[temporal-bun-sdk] lifecycle scenario skipped (${name})`)
      return undefined
    }
    if (!harness) {
      throw new Error('Integration harness not initialised')
    }
    try {
      return await Effect.runPromise(
        harness.runScenario(name, () => Effect.tryPromise(scenario)),
      )
    } catch (error) {
      if (error instanceof TemporalCliUnavailableError) {
        cliUnavailable = true
        console.warn(`[temporal-bun-sdk] lifecycle scenario skipped (${name}): ${error.message}`)
        return undefined
      }
      throw error
    }
  }

  test('long-running heartbeat keeps activity alive', { timeout: scenarioTimeoutMs }, async () => {
    await runOrSkip('heartbeat-success', async () => {
      const handle = await executeWorkflow(heartbeatWorkflow.name, {
        durationMs: 600,
        heartbeatTimeoutMs: 300,
      })
      const history = await fetchWorkflowHistory(handle)
      const scheduled = history.filter((event) => event.eventType === EventType.ACTIVITY_TASK_SCHEDULED)
      const completed = history.filter((event) => event.eventType === EventType.ACTIVITY_TASK_COMPLETED)
      expect(scheduled.length).toBeGreaterThan(0)
      expect(completed.length).toBeGreaterThan(0)
    })
  })

  test('heartbeat timeout triggers cancellation', { timeout: scenarioTimeoutMs }, async () => {
    await runOrSkip('heartbeat-timeout', async () => {
      const handle = await executeWorkflow(heartbeatTimeoutWorkflow.name, {
        initialBeats: 2,
        stallMs: 800,
        heartbeatTimeoutMs: 200,
      })
      const history = await fetchWorkflowHistory(handle)
      const activityTimedOut = history.some((event) => event.eventType === EventType.ACTIVITY_TASK_TIMED_OUT)
      expect(activityTimedOut).toBe(true)
    })
  })

  test('retry exhaustion halts after non-retryable error', { timeout: scenarioTimeoutMs }, async () => {
    await runOrSkip('retry-exhaustion', async () => {
      const handle = await executeWorkflow(retryProbeWorkflow.name, {
        failUntil: 2,
        permanentOn: 3,
        maxAttempts: 3,
      })
      const history = await fetchWorkflowHistory(handle)
      const failedEvent = history.find((event) => event.eventType === EventType.ACTIVITY_TASK_FAILED)
      expect(failedEvent).toBeDefined()
    })
  })

  const executeWorkflow = async (workflowType: string, args: Record<string, unknown>): Promise<WorkflowExecutionHandle> => {
    if (!harness) {
      throw new Error('Integration harness not initialised')
    }
    try {
      return await Effect.runPromise(
        harness.executeWorkflow({
          workflowType,
          workflowId: `lifecycle-${crypto.randomUUID()}`,
          taskQueue: CLI_CONFIG.taskQueue,
          args: [args],
        }),
      )
    } catch (error) {
      if (error instanceof TemporalCliCommandError) {
        console.error('[temporal-bun-sdk] temporal CLI stdout', error.stdout)
        console.error('[temporal-bun-sdk] temporal CLI stderr', error.stderr)
      }
      throw error
    }
  }

  const fetchWorkflowHistory = async (handle: WorkflowExecutionHandle) => {
    if (!harness) {
      throw new Error('Integration harness not initialised')
    }
    return await Effect.runPromise(harness.fetchWorkflowHistory(handle))
  }
})
