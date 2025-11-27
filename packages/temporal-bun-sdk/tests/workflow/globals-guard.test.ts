import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { createDefaultDataConverter } from '../../src/common/payloads'
import type { ExecuteWorkflowInput, WorkflowExecutionOutput } from '../../src/workflow/executor'
import { WorkflowExecutor } from '../../src/workflow/executor'
import { defineWorkflow } from '../../src/workflow/definition'
import { WorkflowRegistry } from '../../src/workflow/registry'
import { WorkflowNondeterminismError } from '../../src/workflow/errors'

const makeExecutor = () => {
  const registry = new WorkflowRegistry()
  const dataConverter = createDefaultDataConverter()
  const executor = new WorkflowExecutor({ registry, dataConverter })
  return { registry, executor }
}

const execute = async (
  executor: WorkflowExecutor,
  overrides: Partial<ExecuteWorkflowInput> & Pick<ExecuteWorkflowInput, 'workflowType' | 'arguments'>,
): Promise<WorkflowExecutionOutput> =>
  await executor.execute({
    workflowType: overrides.workflowType,
    arguments: overrides.arguments,
    workflowId: overrides.workflowId ?? 'wf-globals',
    runId: overrides.runId ?? 'run-globals',
    namespace: overrides.namespace ?? 'default',
    taskQueue: overrides.taskQueue ?? 'determinism-tests',
    determinismState: overrides.determinismState,
  })

test('WeakRef usage is rejected inside workflow execution', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow(
      'weakRefWorkflow',
      Schema.Array(Schema.Unknown),
      () =>
        Effect.sync(() => {
          // eslint-disable-next-line no-new
          new WeakRef({ value: 1 })
          return 'ok'
        }),
    ),
  )

  await expect(execute(executor, { workflowType: 'weakRefWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('FinalizationRegistry usage is rejected inside workflow execution', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow(
      'finalizationWorkflow',
      Schema.Array(Schema.Unknown),
      () =>
        Effect.sync(() => {
          // eslint-disable-next-line no-new
          new FinalizationRegistry(() => undefined)
          return 'ok'
        }),
    ),
  )

  await expect(execute(executor, { workflowType: 'finalizationWorkflow', arguments: [] })).rejects.toBeInstanceOf(
    WorkflowNondeterminismError,
  )
})

test('deterministic workflow still succeeds after guard restores globals', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow(
      'safeWorkflow',
      Schema.Array(Schema.Number),
      ({ input }) => Effect.sync(() => (input[0] ?? 0) + 1),
    ),
  )

  const output = await execute(executor, { workflowType: 'safeWorkflow', arguments: [41] })

  expect(output.completion).toBe('completed')
  expect(output.result).toBe(42)
})
