import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { createDefaultDataConverter } from '../../src/common/payloads'
import { defineWorkflow } from '../../src/workflow/definition'
import { WorkflowExecutor } from '../../src/workflow/executor'
import { WorkflowNondeterminismError } from '../../src/workflow/errors'
import { WorkflowRegistry } from '../../src/workflow/registry'

const makeExecutor = () => {
  const registry = new WorkflowRegistry()
  const dataConverter = createDefaultDataConverter()
  const executor = new WorkflowExecutor({ registry, dataConverter })
  return { registry, executor }
}

const execute = (
  executor: WorkflowExecutor,
  workflowType: string,
  args: unknown[] = [],
) =>
  executor.execute({
    workflowType,
    arguments: args,
    workflowId: 'wf-id',
    runId: 'run-id',
    namespace: 'default',
    taskQueue: 'test-queue',
  })

test('throws when workflow touches WeakRef', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow(
      'usesWeakRef',
      Schema.Array(Schema.Unknown),
      () =>
        Effect.sync(() => {
          // @ts-expect-error WeakRef override should throw inside workflows
          const ref = new WeakRef({ value: 1 })
          return ref.deref()
        }),
    ),
  )

  await expect(execute(executor, 'usesWeakRef')).rejects.toThrow(WorkflowNondeterminismError)
})

test('throws when workflow registers FinalizationRegistry', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow(
      'usesFinalizationRegistry',
      Schema.Array(Schema.Unknown),
      () =>
        Effect.sync(() => {
          // @ts-expect-error FinalizationRegistry override should throw inside workflows
          new FinalizationRegistry(() => {})
          return 'ok'
        }),
    ),
  )

  await expect(execute(executor, 'usesFinalizationRegistry')).rejects.toThrow(WorkflowNondeterminismError)
})

test('restores global constructors after execution', async () => {
  const originalWeakRef = globalThis.WeakRef
  const originalFinalizationRegistry = globalThis.FinalizationRegistry
  const { registry, executor } = makeExecutor()

  registry.register(
    defineWorkflow(
      'no-op',
      Schema.Array(Schema.Unknown),
      () => Effect.sync(() => 'ok'),
    ),
  )

  await expect(execute(executor, 'no-op')).resolves.toBeDefined()
  expect(globalThis.WeakRef).toBe(originalWeakRef)
  expect(globalThis.FinalizationRegistry).toBe(originalFinalizationRegistry)
})
