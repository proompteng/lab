import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'

import { Effect, Exit } from 'effect'

import { loadTemporalConfig } from '../../src/config'
import { EventType } from '../../src/proto/temporal/api/enums/v1/event_type_pb'
import { WorkerRuntime } from '../../src/worker/runtime'
import {
  TemporalCliCommandError,
  TemporalCliUnavailableError,
  createIntegrationHarness,
  type IntegrationHarness,
  type TemporalDevServerConfig,
  type WorkflowExecutionHandle,
} from './harness'
import { integrationActivities, integrationWorkflows, queryOnlyWorkflow } from './workflows'

const shouldRunIntegration = process.env.TEMPORAL_INTEGRATION_TESTS === '1'
const describeIntegration = shouldRunIntegration ? describe : describe.skip
const scenarioTimeoutMs = 60_000
const hookTimeoutMs = 60_000

const CLI_CONFIG: TemporalDevServerConfig = {
  address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'temporal-bun-integration',
}

describeIntegration('Query-only workflow tasks', () => {
  let harness: IntegrationHarness | null = null
  let runtime: WorkerRuntime | null = null
  let runtimePromise: Promise<void> | null = null
  let cliUnavailable = false

  beforeAll(async () => {
    const harnessExit = await Effect.runPromiseExit(createIntegrationHarness(CLI_CONFIG))
    if (Exit.isFailure(harnessExit)) {
      if (harnessExit.cause instanceof TemporalCliUnavailableError) {
        cliUnavailable = true
        console.warn(`[temporal-bun-sdk] skipping query-only integration: ${harnessExit.cause.message}`)
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
      namespace: runtimeConfig.namespace,
      stickyScheduling: false,
      deployment: undefined,
      workflowGuards: 'warn',
    })
    runtimePromise = runtime.run().catch((error) => {
      console.error('[temporal-bun-sdk] integration worker runtime exited', error)
      throw error
    })
  }, { timeout: hookTimeoutMs })

  afterAll(async () => {
    if (runtime) {
      await runtime.shutdown().catch((error) => {
        console.error('[temporal-bun-sdk] failed to shutdown runtime', error)
      })
    }
    if (runtimePromise) {
      await runtimePromise.catch(() => {})
    }
    if (harness) {
      await Effect.runPromise(harness.teardown)
    }
  }, { timeout: hookTimeoutMs })

  const runTemporalCli = async (...args: string[]): Promise<string> => {
    const child = Bun.spawn(['temporal', '--address', CLI_CONFIG.address, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        TEMPORAL_ADDRESS: CLI_CONFIG.address,
        TEMPORAL_NAMESPACE: CLI_CONFIG.namespace,
      },
    })
    const exitCode = await child.exited
    const stdout = child.stdout ? await new Response(child.stdout).text() : ''
    const stderr = child.stderr ? await new Response(child.stderr).text() : ''
    if (exitCode !== 0) {
      throw new TemporalCliCommandError(['temporal', ...args], exitCode, stdout, stderr)
    }
    return stdout.trim()
  }

  const executeWorkflow = async (workflowType: string): Promise<WorkflowExecutionHandle> => {
    if (!harness) {
      throw new Error('Integration harness not initialised')
    }
    return await Effect.runPromise(
      harness.executeWorkflow({
        workflowType,
        workflowId: `query-only-${crypto.randomUUID()}`,
        taskQueue: CLI_CONFIG.taskQueue,
        args: [],
        startOnly: true,
      }),
    )
  }

  const fetchWorkflowHistory = async (handle: WorkflowExecutionHandle) => {
    if (!harness) {
      throw new Error('Integration harness not initialised')
    }
    return await Effect.runPromise(harness.fetchWorkflowHistory(handle))
  }

  const queryWorkflow = async (handle: WorkflowExecutionHandle) => {
    const args = [
      'workflow',
      'query',
      '--workflow-id',
      handle.workflowId,
      '--run-id',
      handle.runId,
      '--namespace',
      CLI_CONFIG.namespace,
      '--name',
      'status',
      '--input',
      '{}',
      '--output',
      'json',
    ]

    const extractStatus = (value: unknown): string | undefined => {
      if (typeof value === 'string') {
        return value
      }
      if (Array.isArray(value)) {
        return value.length > 0 ? extractStatus(value[0]) : undefined
      }
      if (value && typeof value === 'object') {
        const candidate = value as Record<string, unknown>
        if (typeof candidate.status === 'string') {
          return candidate.status
        }
        if (typeof candidate.message === 'string') {
          return candidate.message
        }
        if (candidate.queryResult !== undefined) {
          return extractStatus(candidate.queryResult)
        }
        if (candidate.result !== undefined) {
          return extractStatus(candidate.result)
        }
      }
      return undefined
    }

    const maxAttempts = 5
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const stdout = await runTemporalCli(...args)
        const parsed = JSON.parse(stdout)
        return { status: extractStatus(parsed) }
      } catch (error) {
        if (
          error instanceof TemporalCliCommandError &&
          /workflow is busy/i.test(error.stderr || error.stdout || '') &&
          attempt < maxAttempts
        ) {
          await Bun.sleep(300 * attempt)
          continue
        }
        throw error
      }
    }
    throw new Error('query retries exhausted')
  }

  const runOrSkip = async (name: string, scenario: () => Promise<void>) => {
    if (cliUnavailable) {
      console.warn(`[temporal-bun-sdk] CLI unavailable; skipping query-only scenario "${name}"`)
      return
    }
    await scenario()
  }

  test('workflow queries resolve while execution is blocked', async () => {
    await runOrSkip('query-only blocked workflow', async () => {
      const handle = await executeWorkflow(queryOnlyWorkflow.name)
      const start = Date.now()
      const result = await queryWorkflow(handle)
      const elapsed = Date.now() - start

      expect(result.status).toBe('blocked-on-timer')
      expect(elapsed).toBeLessThan(5_000)

      const history = await fetchWorkflowHistory(handle)
      const completed = history.find((event) => event.eventType === EventType.WORKFLOW_EXECUTION_COMPLETED)
      expect(completed).toBeUndefined()
    })
  }, scenarioTimeoutMs)
})
