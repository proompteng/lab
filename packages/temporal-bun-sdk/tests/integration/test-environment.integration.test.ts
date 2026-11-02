import { afterAll, beforeAll, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { Effect } from 'effect'

import { createDefaultDataConverter } from '../../src/common/payloads'
import { TestWorkflowEnvironment } from '../../src/testing'
import { defineWorkflow } from '../../src/workflow/definition'
import { integrationActivities, integrationWorkflows } from './workflows'
import { acquireIntegrationTestEnv, releaseIntegrationTestEnv, type IntegrationTestEnv } from './test-env'
import { runHarnessEffect } from './harness'

let env: IntegrationTestEnv | null = null
const hookTimeoutMs = 60_000

beforeAll(async () => {
  env = await acquireIntegrationTestEnv()
}, { timeout: hookTimeoutMs })

afterAll(async () => {
  await releaseIntegrationTestEnv()
}, { timeout: hookTimeoutMs })

test('TestWorkflowEnvironment runs a worker end-to-end', { timeout: 30_000 }, async () => {
  if (!env) {
    throw new Error('integration env not initialised')
  }

  await env.runOrSkip('test-workflow-env', async () => {
    const taskQueue = `test-env-${crypto.randomUUID()}`
    const testEnv = await TestWorkflowEnvironment.createExisting({
      address: env.cliConfig.address,
      namespace: env.cliConfig.namespace,
      taskQueue,
    })

    const { worker } = await testEnv.createWorker({
      workflows: integrationWorkflows,
      activities: integrationActivities,
      taskQueue,
      namespace: env.cliConfig.namespace,
      workflowGuards: 'warn',
    })

    const workerPromise = worker.run()

    try {
      const handle = await testEnv.client.startWorkflow({
        workflowType: 'integrationActivityWorkflow',
        workflowId: `test-env-${crypto.randomUUID()}`,
        taskQueue,
        args: [{ value: 'ok' }],
      })
      env.harness?.trackWorkflow(handle)
      const result = await testEnv.client.workflow.result(handle)
      expect(result).toBe('ok')
    } finally {
      await worker.shutdown()
      await workerPromise
      await testEnv.shutdown()
    }
  })
})

test('async local activity deadlines persist before workflow tasks time out', { timeout: 30_000 }, async () => {
  if (!env) throw new Error('integration env not initialised')
  const integration = env
  await integration.runOrSkip('local-activity-deadline', async () => {
    const taskQueue = `local-deadline-${crypto.randomUUID()}`
    const testEnv = await TestWorkflowEnvironment.createExisting({
      address: integration.cliConfig.address, namespace: integration.cliConfig.namespace, taskQueue,
    })
    let invocations = 0
    const { worker } = await testEnv.createWorker({
      taskQueue, workflowGuards: 'warn',
      workflows: [defineWorkflow('localDeadline', ({ determinism, activities }) => Effect.gen(function* () {
        determinism.localActivity('slow', [], {
          handler: async () => { invocations += 1; await Bun.sleep(1500); return 42 },
        })
        return yield* activities.schedule('echo', ['after-deadline'])
      }))],
      activities: { echo: (value: unknown) => value },
    })
    const running = worker.run()
    try {
      const handle = await testEnv.client.startWorkflow({
        workflowType: 'localDeadline', workflowId: `local-deadline-${crypto.randomUUID()}`, taskQueue,
        workflowTaskTimeoutMs: 1000, workflowExecutionTimeoutMs: 5000,
      })
      integration.harness?.trackWorkflow(handle)
      expect(await testEnv.client.workflow.result(handle)).toBe('after-deadline')
      await Bun.sleep(1600)
      if (!integration.harness) throw new Error('integration harness unavailable')
      const history = await runHarnessEffect(integration.harness.fetchWorkflowHistory(handle))
      expect(history.filter((event) => event.attributes?.case === 'workflowTaskTimedOutEventAttributes')).toHaveLength(0)
      const marker = history.find((event) => event.attributes?.case === 'markerRecordedEventAttributes' &&
        event.attributes.value.markerName === 'temporal-bun-sdk/local-activity')?.attributes
      if (marker?.case !== 'markerRecordedEventAttributes') throw new Error('Local activity marker missing')
      const converter = createDefaultDataConverter()
      expect(await converter.fromPayloads(marker.value.details.status?.payloads ?? [])).toEqual(['failed'])
      expect(invocations).toBe(1)
    } finally {
      await worker.shutdown()
      await running
      await testEnv.shutdown()
    }
  })
})
