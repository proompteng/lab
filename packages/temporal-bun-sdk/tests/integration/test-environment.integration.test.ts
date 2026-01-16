import { afterAll, beforeAll, expect, test } from 'bun:test'
import crypto from 'node:crypto'

import { TestWorkflowEnvironment } from '../../src/testing'
import { integrationActivities, integrationWorkflows } from './workflows'
import { acquireIntegrationTestEnv, releaseIntegrationTestEnv, type IntegrationTestEnv } from './test-env'

let env: IntegrationTestEnv | null = null

beforeAll(async () => {
  env = await acquireIntegrationTestEnv()
})

afterAll(async () => {
  await releaseIntegrationTestEnv()
})

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
    })

    const workerPromise = worker.run()

    try {
      const handle = await testEnv.client.startWorkflow({
        workflowType: 'integrationActivityWorkflow',
        workflowId: `test-env-${crypto.randomUUID()}`,
        taskQueue,
        args: [{ value: 'ok' }],
      })
      const result = await testEnv.client.workflow.result(handle)
      expect(result).toBe('ok')
    } finally {
      await worker.shutdown()
      await workerPromise
      await testEnv.shutdown()
    }
  })
})
