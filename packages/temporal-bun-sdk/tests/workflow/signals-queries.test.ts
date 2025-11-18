import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { createWorkflowContext } from '../../src/workflow/context'
import { DeterminismGuard } from '../../src/workflow/determinism'
import { WorkflowBlockedError } from '../../src/workflow/errors'
import { defineWorkflowQueries, defineWorkflowSignals } from '../../src/workflow/inbound'

type TestWorkflowInfo = Parameters<typeof createWorkflowContext>[0]['info']

const baseInfo: TestWorkflowInfo = {
  namespace: 'default',
  taskQueue: 'test-task-queue',
  workflowId: 'test-workflow-id',
  runId: 'test-run-id',
  workflowType: 'test-workflow',
}

test('signals waitFor/on/drain decode payloads and record determinism entries', async () => {
  const guard = new DeterminismGuard()
  const handles = defineWorkflowSignals({
    unblock: Schema.String,
    finish: Schema.Struct({}),
  })
  const deliveries = [
    { name: 'unblock', args: ['ready'], metadata: { eventId: '5', identity: 'cli' } },
    { name: 'finish', args: [{}], metadata: { eventId: '6', workflowTaskCompletedEventId: '10' } },
  ]

  const { context } = createWorkflowContext({
    input: [],
    info: baseInfo,
    determinismGuard: guard,
    signalDeliveries: deliveries,
  })

  const waitResult = await Effect.runPromise(context.signals.waitFor(handles.unblock))
  expect(waitResult.payload).toBe('ready')
  expect(waitResult.metadata.eventId).toBe('5')

  const drainResult = await Effect.runPromise(context.signals.drain(handles.finish))
  expect(drainResult).toHaveLength(1)
  expect(drainResult[0]?.metadata.workflowTaskCompletedEventId).toBe('10')

  await expect(Effect.runPromise(context.signals.waitFor(handles.unblock))).rejects.toThrow(
    'Signal "unblock" not yet delivered',
  )

  const snapshot = guard.snapshot
  expect(snapshot.signals).toHaveLength(2)
  expect(snapshot.signals[0]?.signalName).toBe('unblock')
  expect(snapshot.signals[1]?.signalName).toBe('finish')
})

test('query registry registers resolvers and records evaluations', async () => {
  const guard = new DeterminismGuard()
  const queryHandles = defineWorkflowQueries({
    state: {
      input: Schema.Struct({ includeMeta: Schema.Boolean }),
      output: Schema.Struct({ status: Schema.String }),
    },
  })

  const { context } = createWorkflowContext({
    input: [],
    info: baseInfo,
    determinismGuard: guard,
  })

  await Effect.runPromise(
    context.queries.register(queryHandles.state, (input, metadata) =>
      Effect.sync(() => ({ status: input.includeMeta ? metadata.identity ?? 'unknown' : 'anonymous' })),
    ),
  )

  const resolved = await Effect.runPromise(
    context.queries.resolve(queryHandles.state, { includeMeta: true }, { identity: 'cli-user', id: 'query-1' }),
  )
  expect(resolved.status).toBe('cli-user')

  const snapshot = guard.snapshot
  expect(snapshot.queries).toHaveLength(1)
  expect(snapshot.queries[0]?.queryName).toBe('state')
  expect(snapshot.queries[0]?.handlerName).toBeDefined()
})
