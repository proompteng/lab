import { expect, test } from 'bun:test'
import { Effect, Fiber, Schema } from 'effect'

import { createDefaultDataConverter } from '../../src/common/payloads'
import type { WorkflowActivation, WorkflowActivationJob } from '../../src/workflow/activation'
import { defineWorkflow, defineWorkflowUpdates, type WorkflowDefinition } from '../../src/workflow/definition'
import { WorkflowExecutor } from '../../src/workflow/executor'
import { WorkflowNondeterminismError } from '../../src/workflow/errors'
import { defineWorkflowSignals } from '../../src/workflow/inbound'
import { WorkflowRegistry } from '../../src/workflow/registry'

const input = { namespace: 'test', taskQueue: 'test', workflowId: 'workflow', runId: 'run', arguments: [] }
const complete = (id: string, value: unknown = id): WorkflowActivationJob => ({
  type: 'activity',
  id,
  resolution: { status: 'completed', value },
})
const activation = (...jobs: WorkflowActivationJob[]): WorkflowActivation => ({ jobs })
const executorFor = <I, O>(definition: WorkflowDefinition<I, O>) => {
  const registry = new WorkflowRegistry()
  registry.register(definition)
  return new WorkflowExecutor({ registry, dataConverter: createDefaultDataConverter() })
}

test('durable suspension does not enter cause handlers or finalizers', async () => {
  let caught = 0
  let finalized = 0
  const definition = defineWorkflow('caught-suspension', (ctx) =>
    ctx.activities.schedule('A', [], { activityId: 'A' }).pipe(
      Effect.catchAllCause(() =>
        Effect.sync(() => {
          caught += 1
          return 'fallback'
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          finalized += 1
        }),
      ),
    ),
  )
  const executor = executorFor(definition)
  const roots = Fiber.unsafeRoots(undefined).length
  const first = await executor.execute({ ...input, workflowType: definition.name })
  expect(first.completion).toBe('pending')
  expect(first.intents.map((intent) => intent.kind)).toEqual(['schedule-activity'])
  expect({ caught, finalized }).toEqual({ caught: 0, finalized: 0 })
  expect(Fiber.unsafeRoots(undefined).length).toBe(roots)

  const final = await executor.execute({
    ...input,
    workflowType: definition.name,
    determinismState: first.determinismState,
    activityResults: new Map([['A', { status: 'completed', value: 'done' }]]),
    activations: [activation(), activation(complete('A', 'done'))],
  })
  expect(final.completion).toBe('completed')
  expect(final.result).toBe('done')
  expect({ caught, finalized }).toEqual({ caught: 0, finalized: 1 })
  expect(Fiber.unsafeRoots(undefined).length).toBe(roots)
})

test('replay resumes parallel branches at their original activation boundaries', async () => {
  const definition = defineWorkflow('parallel-activations', (ctx) =>
    Effect.all(
      [
        Effect.flatMap(ctx.activities.schedule('A', [], { activityId: 'A' }), () =>
          ctx.activities.schedule('C', [], { activityId: 'C' }),
        ),
        ctx.activities.schedule('B', [], { activityId: 'B' }),
      ],
      { concurrency: 'unbounded' },
    ),
  )
  const executor = executorFor(definition)
  const first = await executor.execute({ ...input, workflowType: definition.name })
  expect(first.completion).toBe('pending')
  expect(
    first.intents.map((intent) => (intent.kind === 'schedule-activity' ? intent.activityId : intent.kind)),
  ).toEqual(['A', 'B'])
  const second = await executor.execute({
    ...input,
    workflowType: definition.name,
    determinismState: first.determinismState,
    activityResults: new Map([['A', { status: 'completed', value: 'A' }]]),
    activations: [activation(), activation(complete('A'))],
  })
  expect(second.completion).toBe('pending')
  expect(
    second.intents.map((intent) => (intent.kind === 'schedule-activity' ? intent.activityId : intent.kind)),
  ).toEqual(['C'])
  const final = await executorFor(definition).execute({
    ...input,
    workflowType: definition.name,
    determinismState: second.determinismState,
    activityResults: new Map(['A', 'B', 'C'].map((id) => [id, { status: 'completed' as const, value: id }])),
    activations: [activation(), activation(complete('A')), activation(complete('B'), complete('C'))],
  })
  expect(final.completion).toBe('completed')
  expect(final.result).toEqual(['C', 'B'])
})

test('later signals do not change an earlier drain batch after restart', async () => {
  const signals = defineWorkflowSignals({ item: Schema.Unknown })
  const definition = defineWorkflow('signal-activations', (ctx) =>
    Effect.gen(function* () {
      const batch = yield* ctx.signals.drain(signals.item)
      return yield* ctx.activities.schedule('echo', [batch.map((item) => item.payload)], { activityId: 'echo' })
    }),
  )
  const firstSignal = { name: 'item', args: ['A'], metadata: { eventId: '2' } }
  const laterSignal = { name: 'item', args: ['B'], metadata: { eventId: '7' } }
  const first = await executorFor(definition).execute({
    ...input,
    workflowType: definition.name,
    signalDeliveries: [firstSignal],
    activations: [activation({ type: 'signal', delivery: firstSignal })],
  })
  expect(first.completion).toBe('pending')
  const final = await executorFor(definition).execute({
    ...input,
    workflowType: definition.name,
    determinismState: first.determinismState,
    signalDeliveries: [firstSignal, laterSignal],
    activityResults: new Map([['echo', { status: 'completed', value: ['A'] }]]),
    activations: [
      activation({ type: 'signal', delivery: firstSignal }),
      activation({ type: 'signal', delivery: laterSignal }),
      activation(complete('echo', ['A'])),
    ],
  })
  expect(final.completion).toBe('completed')
  expect(final.result).toEqual(['A'])
})

test('actual activity failure remains catchable and finalizes once', async () => {
  let finalized = 0
  const definition = defineWorkflow('failed-activity-activation', (ctx) =>
    ctx.activities.schedule('charge', [], { activityId: 'charge' }).pipe(
      Effect.catchAll((error) => Effect.succeed(error instanceof Error ? error.message : 'unexpected')),
      Effect.ensuring(
        Effect.sync(() => {
          finalized += 1
        }),
      ),
    ),
  )
  const first = await executorFor(definition).execute({ ...input, workflowType: definition.name })
  expect(first.completion).toBe('pending')
  expect(finalized).toBe(0)
  const final = await executorFor(definition).execute({
    ...input,
    workflowType: definition.name,
    determinismState: first.determinismState,
    activations: [
      activation(),
      activation({
        type: 'activity',
        id: 'charge',
        resolution: { status: 'failed', error: new Error('declined') },
      }),
    ],
  })
  expect(final.completion).toBe('completed')
  expect(final.result).toBe('declined')
  expect(finalized).toBe(1)
})

test('pending update handlers resume on later activations before workflow completion', async () => {
  const updates = defineWorkflowUpdates([
    {
      name: 'charge',
      input: Schema.Unknown,
      handler: (ctx, value) => ctx.activities.schedule('charge', [value], { activityId: 'update-charge' }),
    },
  ])
  const definition = defineWorkflow('pending-update-activation', () => Effect.succeed('workflow-done'), { updates })
  const invocation = {
    protocolInstanceId: 'charge',
    requestMessageId: 'charge-request',
    updateId: 'charge-update',
    name: 'charge',
    payload: 'order',
    sequencingEventId: '3',
  }
  const first = await executorFor(definition).execute({
    ...input,
    workflowType: definition.name,
    activations: [{ jobs: [], updates: [invocation] }],
  })
  expect(first.completion).toBe('pending')
  expect(first.updateDispatches?.map((dispatch) => dispatch.type)).toEqual(['acceptance'])
  const final = await executorFor(definition).execute({
    ...input,
    workflowType: definition.name,
    determinismState: first.determinismState,
    activations: [{ jobs: [], updates: [invocation] }, activation(complete('update-charge', 'charged'))],
  })
  expect(final.completion).toBe('completed')
  expect(final.result).toBe('workflow-done')
  expect(final.updateDispatches?.find((dispatch) => dispatch.type === 'completion')).toMatchObject({
    status: 'success',
    result: 'charged',
  })
})

test('concurrent workers retain their own guard mode across activations', async () => {
  const registry = new WorkflowRegistry()
  registry.register(
    defineWorkflow('guard-mode-activation', (ctx) =>
      ctx.activities.schedule('A', [], { activityId: 'A' }).pipe(Effect.map(() => performance.now())),
    ),
  )
  const dataConverter = createDefaultDataConverter()
  const strict = new WorkflowExecutor({ registry, dataConverter, workflowGuards: 'strict' })
  const permissive = new WorkflowExecutor({ registry, dataConverter, workflowGuards: 'off' })
  const execution = {
    ...input,
    workflowType: 'guard-mode-activation',
    activations: [activation(), activation(complete('A'))],
  }
  const [strictResult, permissiveResult] = await Promise.allSettled([
    strict.execute(execution),
    permissive.execute(execution),
  ])
  expect(strictResult.status).toBe('rejected')
  if (strictResult.status === 'rejected') expect(strictResult.reason).toBeInstanceOf(WorkflowNondeterminismError)
  expect(permissiveResult.status).toBe('fulfilled')
})

test('timer, Nexus, and signal waits suspend without entering cause handlers', async () => {
  const signals = defineWorkflowSignals({ finish: Schema.Unknown })
  const definition = defineWorkflow('durable-waits', (ctx) =>
    Effect.all(
      [
        ctx.timers.start({ timerId: 'timer', timeoutMs: 100 }),
        ctx.nexus.schedule('endpoint', 'service', 'operation', {}, { operationId: 'nexus' }),
        ctx.signals.waitFor(signals.finish).pipe(Effect.map((signal) => signal.payload)),
      ],
      { concurrency: 'unbounded' },
    ).pipe(Effect.catchAllCause(() => Effect.succeed('caught-pending'))),
  )
  const first = await executorFor(definition).execute({ ...input, workflowType: definition.name })
  expect(first.completion).toBe('pending')
  const second = await executorFor(definition).execute({
    ...input,
    workflowType: definition.name,
    determinismState: first.determinismState,
    activations: [
      activation(),
      activation(
        { type: 'timer', id: 'timer' },
        { type: 'nexus', id: 'nexus', resolution: { status: 'completed', value: 'nexus-result' } },
      ),
    ],
  })
  expect(second.completion).toBe('pending')
  const final = await executorFor(definition).execute({
    ...input,
    workflowType: definition.name,
    determinismState: second.determinismState,
    activations: [
      activation(),
      activation(
        { type: 'timer', id: 'timer' },
        { type: 'nexus', id: 'nexus', resolution: { status: 'completed', value: 'nexus-result' } },
      ),
      activation({ type: 'signal', delivery: { name: 'finish', args: ['signal-result'] } }),
    ],
  })
  expect(final.result).toEqual([{ timerId: 'timer' }, 'nexus-result', 'signal-result'])
})

test('strict workflows reject native Effect timers', async () => {
  const registry = new WorkflowRegistry()
  registry.register(defineWorkflow('native-sleep', () => Effect.sleep(1)))
  registry.register(defineWorkflow('native-never', () => Effect.never))
  const executor = new WorkflowExecutor({
    registry,
    dataConverter: createDefaultDataConverter(),
    workflowGuards: 'strict',
  })
  for (const workflowType of ['native-sleep', 'native-never']) {
    const failure = await executor.execute({ ...input, workflowType }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowNondeterminismError)
  }
})
