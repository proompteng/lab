import { expect, test } from 'bun:test'

import { workflows } from '../../../temporal-bun-sdk-example/src/workflows'
import { createDefaultDataConverter } from '../../src/common/payloads'
import type { WorkflowActivation } from '../../src/workflow/activation'
import { WorkflowExecutor } from '../../src/workflow/executor'
import { WorkflowRegistry } from '../../src/workflow/registry'

test('Effect 4 example schedules durable activities and replays their completed results', async () => {
  const registry = new WorkflowRegistry()
  registry.registerMany(workflows)
  const executor = new WorkflowExecutor({ registry, dataConverter: createDefaultDataConverter() })
  const input = {
    workflowType: 'greetingWorkflow',
    workflowId: 'example',
    runId: 'run',
    namespace: 'test',
    taskQueue: 'test',
    arguments: ['Ada'],
  }
  const activations: WorkflowActivation[] = [{ jobs: [] }]
  const first = await executor.execute({ ...input, activations })
  expect(first.completion).toBe('pending')
  expect(first.intents[0]).toMatchObject({
    kind: 'schedule-activity',
    activityId: 'send-greeting',
    activityType: 'sendGreeting',
    input: [{ to: 'Ada', message: 'Hello, Ada!' }],
  })
  activations.push({
    jobs: [{ type: 'activity', id: 'send-greeting', resolution: { status: 'completed', value: 'sent' } }],
  })
  const second = await executor.execute({ ...input, activations, determinismState: first.determinismState })
  expect(second.completion).toBe('pending')
  expect(second.intents[0]).toMatchObject({
    kind: 'schedule-activity',
    activityId: 'record-metric',
    activityType: 'recordMetric',
    input: ['greeting.sent', 1],
  })
  activations.push({
    jobs: [
      {
        type: 'activity',
        id: 'record-metric',
        resolution: { status: 'completed', value: { name: 'greeting.sent', value: 1 } },
      },
    ],
  })
  const final = await executor.execute({ ...input, activations, determinismState: second.determinismState })
  expect(final.completion).toBe('completed')
  expect(final.result).toEqual({ message: 'Hello, Ada!', dispatchResult: 'sent' })
})
