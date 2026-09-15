import { expect, test } from 'bun:test'

import { TestWorkflowEnvironment } from '../../src/testing'

const baseOptions = {
  address: '127.0.0.1:7233',
  namespace: 'default',
  taskQueue: 'unit-test-env',
  reuseExistingServer: true,
}

test('TestWorkflowEnvironment.createLocal uses provided settings', async () => {
  const env = await TestWorkflowEnvironment.createLocal(baseOptions)

  expect(env.address).toBe(baseOptions.address)
  expect(env.namespace).toBe(baseOptions.namespace)
  expect(env.taskQueue).toBe(baseOptions.taskQueue)
  expect(env.timeSkipping).toBe(false)

  await env.shutdown()
})

test('TestWorkflowEnvironment.createTimeSkipping sets timeSkipping flag', async () => {
  const env = await TestWorkflowEnvironment.createTimeSkipping({
    ...baseOptions,
    taskQueue: 'unit-test-env-time-skipping',
  })

  expect(env.timeSkipping).toBe(true)

  await env.shutdown()
})
