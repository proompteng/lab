import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'

import { Effect } from 'effect'

import { createTemporalClient, type TemporalClient } from '../../src/client'
import type { WorkflowHandle } from '../../src/client/types'
import { loadTemporalConfig } from '../../src/config'
import type { WorkflowExecutionHandle, IntegrationHarness } from './harness'
import { acquireIntegrationTestEnv, releaseIntegrationTestEnv, CLI_CONFIG, type IntegrationTestEnv } from './test-env'

const UPDATE_WORKFLOW_TYPE = 'integrationUpdateWorkflow'
const hookTimeoutMs = 60_000
const scenarioTimeoutMs = 30_000

let integrationEnv: IntegrationTestEnv | null = null
let harness: IntegrationHarness | null = null
let runScenario: (<A>(name: string, scenario: () => Promise<A>) => Promise<A | undefined>) | null = null

beforeAll(async () => {
  integrationEnv = await acquireIntegrationTestEnv()
  harness = integrationEnv.harness
  runScenario = integrationEnv.runOrSkip
}, { timeout: hookTimeoutMs })

afterAll(async () => {
  await releaseIntegrationTestEnv()
}, { timeout: hookTimeoutMs })

const execScenario = async <A>(name: string, scenario: () => Promise<A>): Promise<A | undefined> => {
  if (!runScenario) {
    throw new Error('Integration environment not initialised')
  }
  return runScenario(name, scenario)
}

const startUpdateWorkflow = async (label: string): Promise<WorkflowExecutionHandle> => {
  if (!harness) {
    throw new Error('Integration harness not initialised')
  }
  return Effect.runPromise(
    harness.executeWorkflow({
      workflowType: UPDATE_WORKFLOW_TYPE,
      workflowId: `integration-update-${label}-${randomUUID()}`,
      taskQueue: CLI_CONFIG.taskQueue,
      startOnly: true,
      args: [
        {
          initialMessage: 'booting',
          cycles: 6,
          holdMs: 2_000,
        },
      ],
    }),
  )
}

const toWorkflowHandle = (execution: WorkflowExecutionHandle): WorkflowHandle => ({
  workflowId: execution.workflowId,
  runId: execution.runId,
  namespace: CLI_CONFIG.namespace,
})

const createClient = async (): Promise<TemporalClient> => {
  const config = await loadTemporalConfig({
    defaults: {
      address: CLI_CONFIG.address,
      namespace: CLI_CONFIG.namespace,
      taskQueue: CLI_CONFIG.taskQueue,
    },
  })
  const { client } = await createTemporalClient({ config, taskQueue: CLI_CONFIG.taskQueue })
  return client
}

const terminateWorkflow = async (client: TemporalClient, handle: WorkflowHandle): Promise<void> => {
  try {
    await client.workflow.terminate(handle, { reason: 'integration-test-cleanup' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = typeof error === 'object' && error && 'code' in error ? (error as { code?: unknown }).code : undefined
    if (code === 'not_found') {
      return
    }
    if (!/terminated|not[_\s-]?found|completed/i.test(message)) {
      throw error
    }
  }
}

describe('workflow updates', () => {
  test('workflow update completes successfully', { timeout: scenarioTimeoutMs }, async () => {
    await execScenario('workflow update success', async () => {
      const execution = await startUpdateWorkflow('success')
      const handle = toWorkflowHandle(execution)
      const client = await createClient()
      try {
        const result = await client.workflow.update(handle, {
          updateName: 'integrationUpdate.setMessage',
          args: [{ value: 'ready' }],
          waitForStage: 'completed',
        })
        expect(result.stage).toBe('completed')
        expect(result.outcome?.status).toBe('success')
        expect(result.outcome?.result).toBe('ready')
      } finally {
        await terminateWorkflow(client, handle)
        await client.shutdown()
      }
    })
  })

  test('workflow update rejection surfaces validation failures', { timeout: scenarioTimeoutMs }, async () => {
    await execScenario('workflow update rejection', async () => {
      const execution = await startUpdateWorkflow('rejection')
      const handle = toWorkflowHandle(execution)
      const client = await createClient()
      try {
        const result = await client.workflow.update(handle, {
          updateName: 'integrationUpdate.guardMessage',
          args: [{ value: 'hi' }],
          waitForStage: 'completed',
        })
        expect(result.stage).toBe('completed')
        expect(result.outcome?.status).toBe('failure')
        expect(result.outcome?.error).toBeDefined()
        expect(result.outcome?.error?.message ?? '').toContain('message-too-short')
      } finally {
        await terminateWorkflow(client, handle)
        await client.shutdown()
      }
    })
  })

  test('awaiting a workflow update defaults to waiting for completion', { timeout: scenarioTimeoutMs }, async () => {
    await execScenario('workflow update await default', async () => {
      const execution = await startUpdateWorkflow('await-default')
      const handle = toWorkflowHandle(execution)
      const client = await createClient()
      try {
        const accepted = await client.workflow.update(handle, {
          updateName: 'integrationUpdate.delayedSetMessage',
          args: [{ value: 'default-wait', delayMs: 500 }],
          waitForStage: 'accepted',
        })

        const resolution = await client.workflow.awaitUpdate(accepted.handle)

        expect(resolution.stage).toBe('completed')
        expect(resolution.outcome?.status).toBe('success')
        expect(resolution.outcome?.result).toBe('default-wait')
      } finally {
        await terminateWorkflow(client, handle)
        await client.shutdown()
      }
    })
  })

  test('awaiting a workflow update can be cancelled and retried', { timeout: scenarioTimeoutMs }, async () => {
    await execScenario('workflow update cancellation', async () => {
      const execution = await startUpdateWorkflow('cancel')
      const handle = toWorkflowHandle(execution)
      const client = await createClient()
      try {
        const accepted = await client.workflow.update(handle, {
          updateName: 'integrationUpdate.delayedSetMessage',
          args: [{ value: 'slow-path', delayMs: 1_500 }],
          waitForStage: 'accepted',
        })

        const pending = client.workflow.awaitUpdate(accepted.handle, { waitForStage: 'completed' })
        await client.workflow.cancelUpdate(accepted.handle)

        let aborted = false
        try {
          await pending
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          aborted = (error instanceof Error && error.name === 'AbortError') || /abort/i.test(message)
        }
        expect(aborted).toBe(true)

        const finalResolution = await client.workflow.awaitUpdate(accepted.handle, { waitForStage: 'completed' })
        expect(finalResolution.stage).toBe('completed')
        expect(finalResolution.outcome?.status).toBe('success')
        expect(finalResolution.outcome?.result).toBe('slow-path')
      } finally {
        await terminateWorkflow(client, handle)
        await client.shutdown()
      }
    })
  })
})
