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
import { integrationActivities, integrationWorkflows, signalQueryWorkflow } from './workflows'

const shouldRunIntegration = process.env.TEMPORAL_INTEGRATION_TESTS === '1'
const describeIntegration = shouldRunIntegration ? describe : describe.skip
const scenarioTimeoutMs = 60_000
const hookTimeoutMs = 60_000

const CLI_CONFIG: TemporalDevServerConfig = {
  address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'temporal-bun-integration',
}

describeIntegration('Signal + query integration', () => {
  let harness: IntegrationHarness | null = null
  let runtime: WorkerRuntime | null = null
  let runtimePromise: Promise<void> | null = null
  let cliUnavailable = false

  beforeAll(async () => {
    const harnessExit = await Effect.runPromiseExit(createIntegrationHarness(CLI_CONFIG))
    if (Exit.isFailure(harnessExit)) {
      if (harnessExit.cause instanceof TemporalCliUnavailableError) {
        cliUnavailable = true
        console.warn(`[temporal-bun-sdk] skipping signal/query integration: ${harnessExit.cause.message}`)
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
        workflowId: `signal-query-${crypto.randomUUID()}`,
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

  const sendSignal = async (workflowId: string, runId: string, signal: string, input: string) => {
    await runTemporalCli(
      'workflow',
      'signal',
      '--workflow-id',
      workflowId,
      '--run-id',
      runId,
      '--name',
      signal,
      '--namespace',
      CLI_CONFIG.namespace,
      '--input',
      input,
    )
  }

  const queryWorkflow = async (handle: WorkflowExecutionHandle, query: string) => {
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
      query,
      '--input',
      '{}',
      '--output',
      'json',
    ]
    const maxAttempts = 5
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const stdout = await runTemporalCli(...args)
        const parsed = JSON.parse(stdout)
        if (typeof parsed === 'string') {
          return { message: parsed }
        }
        if (parsed && typeof parsed === 'object') {
          if ('message' in parsed && typeof (parsed as { message?: string }).message === 'string') {
            return { message: (parsed as { message: string }).message }
          }
          if ('queryResult' in parsed) {
            const result = (parsed as { queryResult: unknown }).queryResult
            if (typeof result === 'string') {
              return { message: result }
            }
            if (Array.isArray(result) && result.length > 0) {
              const first = result[0]
              if (typeof first === 'string') {
                return { message: first }
              }
              if (first && typeof first === 'object' && 'message' in first && typeof first.message === 'string') {
                return { message: first.message }
              }
            }
            if (result && typeof result === 'object' && 'message' in result && typeof result.message === 'string') {
              return { message: result.message }
            }
          }
        }
        console.warn('[signal-query:test] unexpected query result payload', parsed)
        return { message: undefined }
      } catch (error) {
        if (
          error instanceof TemporalCliCommandError &&
          /please retry/i.test(error.stderr || error.stdout || '') &&
          attempt < maxAttempts
        ) {
          await Bun.sleep(300 * attempt)
          continue
        }
        throw error
      }
    }
    throw new Error('Query retries exhausted')
  }

  const waitForCompletion = async (handle: WorkflowExecutionHandle) => {
    const deadline = Date.now() + scenarioTimeoutMs
    while (Date.now() < deadline) {
      const history = await fetchWorkflowHistory(handle)
      const lastEvent = history[history.length - 1]
      if (lastEvent?.eventType === EventType.WORKFLOW_EXECUTION_COMPLETED) {
        return
      }
      await Bun.sleep(500)
    }
    throw new Error('workflow did not complete before timeout')
  }

  const runOrSkip = async (name: string, scenario: () => Promise<void>) => {
    if (cliUnavailable) {
      console.warn(`[temporal-bun-sdk] CLI unavailable; skipping signal/query scenario "${name}"`)
      return
    }
    await scenario()
  }

  test('workflow exposes signal-driven query state', async () => {
    await runOrSkip('signal-query', async () => {
      const handle = await executeWorkflow(signalQueryWorkflow.name)
      const initial = await queryWorkflow(handle, 'state')
      expect(initial.message).toBe('waiting')

      await sendSignal(handle.workflowId, handle.runId, 'unblock', '"integration-ready"')
      await Bun.sleep(500)
      const afterFirstSignal = await queryWorkflow(handle, 'state')
      expect(afterFirstSignal.message).toBe('integration-ready')

      await sendSignal(handle.workflowId, handle.runId, 'finish', '{}')
      await waitForCompletion(handle)
      const history = await fetchWorkflowHistory(handle)
      const completed = history.find((event) => event.eventType === EventType.WORKFLOW_EXECUTION_COMPLETED)
      expect(completed).toBeDefined()
    })
  }, scenarioTimeoutMs)
})
