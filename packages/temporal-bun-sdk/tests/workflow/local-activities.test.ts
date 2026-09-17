import { expect, test } from 'bun:test'
import { Effect } from 'effect'

import { createDefaultDataConverter } from '../../src/common/payloads'
import { materializeCommands } from '../../src/workflow/commands'
import { createWorkflowContext } from '../../src/workflow/context'
import { DeterminismGuard } from '../../src/workflow/determinism'

const info = {
  workflowType: 'localActivityWorkflow',
  workflowId: 'local-activity',
  runId: 'local-activity-run',
  namespace: 'default',
  taskQueue: 'local-activities',
}

test('async local activities persist their resolved result and return a promise on replay', async () => {
  const converter = createDefaultDataConverter()
  const guard = new DeterminismGuard()
  const initial = createWorkflowContext({ info, input: [], determinismGuard: guard })
  let invocations = 0
  const options = {
    handler: async () => {
      invocations += 1
      return 42
    },
  }
  expect(await initial.context.determinism.localActivity<Promise<number>>('lookup', [], options)).toBe(42)
  const commands = await materializeCommands(initial.commandContext.intents, { dataConverter: converter })
  const attributes = commands[0]?.attributes
  expect(attributes?.case).toBe('recordMarkerCommandAttributes')
  if (attributes?.case !== 'recordMarkerCommandAttributes') throw new Error('Local activity marker missing')
  expect(await converter.fromPayloads(attributes.value.details.result?.payloads ?? [])).toEqual([42])

  const replay = createWorkflowContext({
    info,
    input: [],
    determinismGuard: new DeterminismGuard({ previousState: guard.snapshot }),
  })
  const result = replay.context.determinism.localActivity<Promise<number>>('lookup', [], options)
  expect(result).toBeInstanceOf(Promise)
  expect(await result).toBe(42)
  expect(invocations).toBe(1)
})

test('async local activity rejection is recorded and replayed without another invocation', async () => {
  const guard = new DeterminismGuard()
  const initial = createWorkflowContext({ info, input: [], determinismGuard: guard })
  let invocations = 0
  const options = {
    handler: async () => {
      invocations += 1
      throw new Error('lookup failed')
    },
  }
  await expect(initial.context.determinism.localActivity<Promise<never>>('lookup', [], options)).rejects.toThrow(
    'lookup failed',
  )
  const intent = initial.commandContext.intents[0]
  expect(intent?.kind === 'record-marker' ? intent.details?.status : undefined).toBe('failed')
  const replay = createWorkflowContext({
    info,
    input: [],
    determinismGuard: new DeterminismGuard({ previousState: guard.snapshot }),
  })
  await expect(replay.context.determinism.localActivity<Promise<never>>('lookup', [], options)).rejects.toThrow(
    'lookup failed',
  )
  expect(invocations).toBe(1)
})

test('null local activity results remain null during replay', () => {
  const guard = new DeterminismGuard()
  const initial = createWorkflowContext({ info, input: [], determinismGuard: guard })
  expect(initial.context.determinism.localActivity('lookup', [], { handler: () => null })).toBeNull()
  const replay = createWorkflowContext({
    info,
    input: [],
    determinismGuard: new DeterminismGuard({ previousState: guard.snapshot }),
  })
  expect(replay.context.determinism.localActivity('lookup')).toBeNull()
})

test('concurrent async local activities keep invocation order in recorded markers', async () => {
  const initial = createWorkflowContext({ info, input: [], determinismGuard: new DeterminismGuard() })
  const first = Promise.withResolvers<number>()
  const second = Promise.withResolvers<number>()
  const a = initial.context.determinism.localActivity('first', [], { handler: () => first.promise })
  const b = initial.context.determinism.localActivity('second', [], { handler: () => second.promise })
  second.resolve(2)
  await b
  first.resolve(1)
  await initial.commandContext.settleLocalActivities()
  expect(await a).toBe(1)
  expect(
    initial.commandContext.intents.map((intent) => (intent.kind === 'record-marker' ? intent.details : null)),
  ).toEqual([
    { activityId: 'local-activity-0', activityType: 'first', async: true, status: 'completed', result: 1 },
    { activityId: 'local-activity-1', activityType: 'second', async: true, status: 'completed', result: 2 },
  ])
})

test('Nexus failures enter the recoverable Effect error channel', async () => {
  const initial = createWorkflowContext({
    info,
    input: [],
    determinismGuard: new DeterminismGuard(),
    nexusResults: new Map([['nexus-0', { status: 'failed', error: new Error('service unavailable') }]]),
  })
  const result = await Effect.runPromise(
    initial.context.nexus
      .schedule('endpoint', 'service', 'operation', {})
      .pipe(Effect.catchAll((error) => Effect.succeed(error.message))),
  )
  expect(result).toBe('service unavailable')
})
