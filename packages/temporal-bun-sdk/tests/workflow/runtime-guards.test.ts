import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { createDefaultDataConverter } from '../../src/common/payloads'
import { WorkflowNondeterminismError } from '../../src/workflow/errors'
import type { ExecuteWorkflowInput } from '../../src/workflow/executor'
import { WorkflowExecutor } from '../../src/workflow/executor'
import { defineWorkflow } from '../../src/workflow/definition'
import { WorkflowRegistry } from '../../src/workflow/registry'

const makeExecutor = () => {
  const registry = new WorkflowRegistry()
  const dataConverter = createDefaultDataConverter()
  const executor = new WorkflowExecutor({ registry, dataConverter, workflowGuards: 'strict' })
  return { registry, executor }
}

const execute = async (
  executor: WorkflowExecutor,
  overrides: Partial<ExecuteWorkflowInput> & Pick<ExecuteWorkflowInput, 'workflowType' | 'arguments'>,
) =>
  await executor.execute({
    workflowType: overrides.workflowType,
    arguments: overrides.arguments,
    workflowId: overrides.workflowId ?? 'test-workflow-id',
    runId: overrides.runId ?? 'test-run-id',
    namespace: overrides.namespace ?? 'default',
    taskQueue: overrides.taskQueue ?? 'test-task-queue',
    determinismState: overrides.determinismState,
    activityResults: overrides.activityResults,
    signalDeliveries: overrides.signalDeliveries,
    pendingChildWorkflows: overrides.pendingChildWorkflows,
    queryRequests: overrides.queryRequests,
    updates: overrides.updates,
    mode: overrides.mode,
  })

test('Date.now() is deterministic in workflow context across replays', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('timeWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => [Date.now(), Date.now()]),
    ),
  )

  const first = await execute(executor, { workflowType: 'timeWorkflow', arguments: [] })
  const second = await execute(executor, {
    workflowType: 'timeWorkflow',
    arguments: [],
    determinismState: first.determinismState,
  })

  expect(second.result).toEqual(first.result)
})

test('Math.random() is deterministic in workflow context across replays', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('randomWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => [Math.random(), Math.random()]),
    ),
  )

  const first = await execute(executor, { workflowType: 'randomWorkflow', arguments: [] })
  const second = await execute(executor, {
    workflowType: 'randomWorkflow',
    arguments: [],
    determinismState: first.determinismState,
  })

  expect(second.result).toEqual(first.result)
})

test('fetch() throws in strict mode when called from workflow code', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('fetchWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.tryPromise(async () => {
        await fetch('https://example.com')
        return 'ok'
      }),
    ),
  )

  await expect(execute(executor, { workflowType: 'fetchWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('setTimeout() throws in strict mode when called from workflow code', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('timeoutWorkflow', Schema.Array(Schema.Unknown), () =>
      Effect.sync(() => {
        setTimeout(() => {}, 1)
        return 'ok'
      }),
    ),
  )

  await expect(execute(executor, { workflowType: 'timeoutWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

