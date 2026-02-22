import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { createDefaultDataConverter, decodePayloadsToValues } from '../src/common/payloads'
import type { Logger } from '../src/observability/logger'
import { CommandType } from '../src/proto/temporal/api/enums/v1/command_type_pb'
import type { ActivityResolution } from '../src/workflow/context'
import type { WorkflowDeterminismState } from '../src/workflow/determinism'
import { WorkflowNondeterminismError } from '../src/workflow/errors'
import type { ExecuteWorkflowInput, WorkflowExecutionOutput } from '../src/workflow/executor'
import type { WorkflowUpdateInvocation } from '../src/workflow/executor'
import { WorkflowExecutor } from '../src/workflow/executor'
import { defineWorkflow, defineWorkflowUpdates } from '../src/workflow/definition'
import { defineWorkflowQueries } from '../src/workflow/inbound'
import type { WorkflowQueryRequest } from '../src/workflow/inbound'
import { log } from '../src/workflow/log'
import { WorkflowRegistry } from '../src/workflow/registry'

const makeExecutor = (logger?: Logger) => {
  const registry = new WorkflowRegistry()
  const dataConverter = createDefaultDataConverter()
  const executor = new WorkflowExecutor({ registry, dataConverter, logger })
  return { registry, executor, dataConverter }
}

const execute = async (
  executor: WorkflowExecutor,
  overrides: Partial<ExecuteWorkflowInput> & Pick<ExecuteWorkflowInput, 'workflowType' | 'arguments'>,
): Promise<WorkflowExecutionOutput> =>
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

test('schedules an activity command and completes after result', async () => {
  const { registry, executor, dataConverter } = makeExecutor()
  registry.register(
    defineWorkflow(
      'scheduleActivity',
      Schema.Array(Schema.String),
      ({ input, activities }) =>
        Effect.flatMap(activities.schedule('sendEmail', input), () => Effect.sync(() => 'scheduled')),
    ),
  )

  const initial = await execute(executor, { workflowType: 'scheduleActivity', arguments: ['hello@acme.test'] })

  expect(initial.completion).toBe('pending')
  expect(initial.commands).toHaveLength(1)
  const scheduleCmd = initial.commands[0]
  expect(scheduleCmd.commandType).toBe(CommandType.SCHEDULE_ACTIVITY_TASK)
  const scheduleAttrs = scheduleCmd.attributes?.value
  expect(scheduleAttrs?.activityType?.name).toBe('sendEmail')
  expect(scheduleAttrs?.activityId).toBe('activity-0')
  expect(scheduleAttrs?.useWorkflowBuildId).toBe(true)
  const decoded = await decodePayloadsToValues(dataConverter, scheduleAttrs?.input?.payloads ?? [])
  expect(decoded).toEqual(['hello@acme.test'])

  const completionRun = await execute(executor, {
    workflowType: 'scheduleActivity',
    arguments: ['hello@acme.test'],
    determinismState: cloneState(initial.determinismState),
    activityResults: new Map<string, ActivityResolution>([['activity-0', { status: 'completed', value: 'result' }]]),
  })

  expect(completionRun.completion).toBe('completed')
  expect(completionRun.commands).toHaveLength(1)
  expect(completionRun.commands[0].commandType).toBe(CommandType.COMPLETE_WORKFLOW_EXECUTION)
  const workflowResult = completionRun.result
  expect(workflowResult).toBe('scheduled')
})

test('emits start timer command', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow(
      'startTimer',
      Schema.Array(Schema.Number),
      ({ timers, input }) =>
        Effect.flatMap(timers.start({ timeoutMs: input[0] ?? 1000 }), () => Effect.sync(() => 'done')),
    ),
  )

  const output = await execute(executor, { workflowType: 'startTimer', arguments: [2500] })

  expect(output.completion).toBe('pending')
  expect(output.commands).toHaveLength(1)
  const timerCommand = output.commands[0]
  expect(timerCommand.commandType).toBe(CommandType.START_TIMER)
  expect(timerCommand.attributes?.case).toBe('startTimerCommandAttributes')
  expect(timerCommand.attributes?.value.timerId).toBe('timer-0')
})

test('schedules a child workflow command', async () => {
  const { registry, executor, dataConverter } = makeExecutor()
  registry.register(
    defineWorkflow(
      'childStarter',
      Schema.Array(Schema.String),
      ({ childWorkflows, input }) =>
        Effect.flatMap(
          childWorkflows.start('childWorkflow', input, {
            workflowId: 'child-1',
            taskQueue: 'child-queue',
          }),
          () => Effect.sync(() => null),
        ),
    ),
  )

  const output = await execute(executor, { workflowType: 'childStarter', arguments: ['payload'] })

  expect(output.completion).toBe('pending')
  expect(output.commands).toHaveLength(1)
  const startChildCommand = output.commands[0]
  expect(startChildCommand.commandType).toBe(CommandType.START_CHILD_WORKFLOW_EXECUTION)
  expect(startChildCommand.attributes?.case).toBe('startChildWorkflowExecutionCommandAttributes')
  const attrs = startChildCommand.attributes?.value
  expect(attrs?.workflowType?.name).toBe('childWorkflow')
  expect(attrs?.workflowId).toBe('child-1')
  expect(attrs?.namespace).toBe('')
  expect(attrs?.taskQueue?.name).toBe('child-queue')
  const decoded = await decodePayloadsToValues(dataConverter, attrs?.input?.payloads ?? [])
  expect(decoded).toEqual(['payload'])
})

test('signals an external workflow', async () => {
  const { registry, executor, dataConverter } = makeExecutor()
  registry.register(
    defineWorkflow(
      'signaller',
      Schema.Array(Schema.Unknown),
      ({ signals }) =>
        Effect.flatMap(
          signals.signal(
            'notify',
            ['value'],
            { workflowId: 'target', namespace: 'alt', runId: 'run-target', childWorkflowOnly: true },
          ),
          () => Effect.sync(() => 'ok'),
        ),
    ),
  )

  const output = await execute(executor, { workflowType: 'signaller', arguments: [] })

  const signalCommand = output.commands[0]
  expect(signalCommand.commandType).toBe(CommandType.SIGNAL_EXTERNAL_WORKFLOW_EXECUTION)
  const attrs = signalCommand.attributes?.value
  expect(attrs?.namespace).toBe('alt')
  expect(attrs?.execution?.workflowId).toBe('target')
  expect(attrs?.execution?.runId).toBe('run-target')
  expect(attrs?.childWorkflowOnly).toBe(true)
  const decoded = await decodePayloadsToValues(dataConverter, attrs?.input?.payloads ?? [])
  expect(decoded).toEqual(['value'])
})

test('continue-as-new produces continue command without completion', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow(
      'continuer',
      Schema.Array(Schema.Number),
      ({ continueAsNew }) => continueAsNew({ input: [42], taskQueue: 'replay-queue' }),
    ),
  )

  const output = await execute(executor, { workflowType: 'continuer', arguments: [] })
  expect(output.commands).toHaveLength(1)
  const [continueCmd] = output.commands
  expect(continueCmd.commandType).toBe(CommandType.CONTINUE_AS_NEW_WORKFLOW_EXECUTION)
  expect(continueCmd.attributes?.value.taskQueue?.name).toBe('replay-queue')
  expect(output.completion).toBe('continued-as-new')
})

test('workflow failure returns failure command', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow(
      'fails',
      Schema.Array(Schema.Unknown),
      () => Effect.fail(new Error('boom')),
    ),
  )

  const output = await execute(executor, { workflowType: 'fails', arguments: [] })
  expect(output.commands).toHaveLength(1)
  const [failCmd] = output.commands
  expect(failCmd.commandType).toBe(CommandType.FAIL_WORKFLOW_EXECUTION)
  expect(output.completion).toBe('failed')
})

test('replay with matching determinism state succeeds', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow(
      'deterministic',
      Schema.Array(Schema.Unknown),
      ({ determinism }) =>
        Effect.map(Effect.sync(() => determinism.random()), (value) => (value > 0 ? 'ok' : 'nope')),
    ),
  )

  const first = await execute(executor, { workflowType: 'deterministic', arguments: [] })
  expect(first.completion).toBe('completed')

  const second = await execute(executor, {
    workflowType: 'deterministic',
    arguments: [],
    determinismState: cloneState(first.determinismState),
  })
  expect(second.completion).toBe('completed')
})

test('workflow logs are emitted once on replay', async () => {
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = []
  const logger: Logger = {
    log: (level, message, fields) =>
      Effect.sync(() => {
        logs.push({ level, message, fields: fields as Record<string, unknown> })
      }),
  }
  const { registry, executor } = makeExecutor(logger)
  registry.register(
    defineWorkflow(
      'logWorkflow',
      Schema.Array(Schema.Unknown),
      () =>
        Effect.sync(() => {
          log.info('first log', { step: 'one' })
          log.warn('second log', { step: 'two' })
          return 'done'
        }),
    ),
  )

  const first = await execute(executor, { workflowType: 'logWorkflow', arguments: [] })
  expect(first.completion).toBe('completed')
  expect(first.determinismState.logCount).toBe(2)
  expect(logs).toHaveLength(2)
  expect(logs[0]?.fields).toMatchObject({
    namespace: 'default',
    taskQueue: 'test-task-queue',
    workflowId: 'test-workflow-id',
    runId: 'test-run-id',
    workflowType: 'logWorkflow',
    sdkComponent: 'workflow',
    step: 'one',
  })

  const second = await execute(executor, {
    workflowType: 'logWorkflow',
    arguments: [],
    determinismState: cloneState(first.determinismState),
  })
  expect(second.completion).toBe('completed')
  expect(logs).toHaveLength(2)
})

test('evaluates registered workflow queries with encoded results', async () => {
  const { registry, executor, dataConverter } = makeExecutor()
  const queries = defineWorkflowQueries({
    state: {
      input: Schema.Struct({}),
      output: Schema.Struct({ status: Schema.String }),
    },
  })
  registry.register(
    defineWorkflow({
      name: 'queryWorkflow',
      queries,
      handler: ({ queries: registryQueries }) =>
        Effect.gen(function* () {
          let status = 'starting'
          yield* registryQueries.register(queries.state, () => Effect.sync(() => ({ status })))
          status = 'ready'
          return status
        }),
    }),
  )

  const queryRequests: WorkflowQueryRequest[] = [
    { id: 'q-1', name: 'state', args: [{}], metadata: undefined, source: 'multi' },
  ]
  const output = await execute(executor, {
    workflowType: 'queryWorkflow',
    arguments: [],
    queryRequests,
  })

  expect(output.queryResults).toHaveLength(1)
  const [entry] = output.queryResults
  expect(entry?.request.id).toBe('q-1')
  const answerValues = await decodePayloadsToValues(dataConverter, entry?.result.answer?.payloads ?? [])
  expect(answerValues[0]).toEqual({ status: 'ready' })
  expect(output.determinismState.queries.length).toBeGreaterThan(0)
})

test('workflow query logs are emitted once on replay', async () => {
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = []
  const logger: Logger = {
    log: (level, message, fields) =>
      Effect.sync(() => {
        logs.push({ level, message, fields: fields as Record<string, unknown> })
      }),
  }
  const { registry, executor } = makeExecutor(logger)
  const queries = defineWorkflowQueries({
    status: {
      input: Schema.Struct({}),
      output: Schema.String,
    },
  })
  registry.register(
    defineWorkflow({
      name: 'queryLogWorkflow',
      queries,
      handler: ({ queries: registryQueries }) =>
        Effect.gen(function* () {
          yield* registryQueries.register(queries.status, () =>
            Effect.sync(() => {
              log.info('query log', { query: 'status' })
              return 'ready'
            }),
          )
          return 'ready'
        }),
    }),
  )

  const first = await execute(executor, {
    workflowType: 'queryLogWorkflow',
    arguments: [],
    queryRequests: [{ name: 'status', args: [{}], source: 'legacy' }],
  })
  expect(first.completion).toBe('completed')
  expect(first.determinismState.logCount).toBe(1)
  expect(logs).toHaveLength(1)
  expect(logs[0]?.fields).toMatchObject({
    namespace: 'default',
    taskQueue: 'test-task-queue',
    workflowId: 'test-workflow-id',
    runId: 'test-run-id',
    workflowType: 'queryLogWorkflow',
    sdkComponent: 'workflow',
    query: 'status',
  })

  const second = await execute(executor, {
    workflowType: 'queryLogWorkflow',
    arguments: [],
    determinismState: cloneState(first.determinismState),
    queryRequests: [{ name: 'status', args: [{}], source: 'legacy' }],
  })
  expect(second.completion).toBe('completed')
  expect(logs).toHaveLength(1)
})

test('query execution mode returns answers without emitting commands', async () => {

  const { registry, executor, dataConverter } = makeExecutor()
  const queries = defineWorkflowQueries({
    status: {
      input: Schema.Struct({}),
      output: Schema.String,
    },
  })

  registry.register(
    defineWorkflow({
      name: 'queryOnlyWorkflow',
      queries,
      handler: ({ queries: registryQueries }) =>
        Effect.gen(function* () {
          let current = 'booting'
          yield* registryQueries.register(queries.status, () => Effect.sync(() => current))
          current = 'ready'
          return current
        }),
    }),
  )

  const output = await execute(executor, {
    workflowType: 'queryOnlyWorkflow',
    arguments: [],
    queryRequests: [{ name: 'status', args: [{}], source: 'legacy' }],
    mode: 'query',
  })

  expect(output.commands).toHaveLength(0)
  expect(output.completion).toBe('completed')
  expect(output.queryResults).toHaveLength(1)
  const [entry] = output.queryResults
  const values = await decodePayloadsToValues(dataConverter, entry?.result.answer?.payloads ?? [])
  expect(values[0]).toBe('ready')
})

test('query execution mode rejects new workflow commands', async () => {
  const { registry, executor } = makeExecutor()

  registry.register(
    defineWorkflow(
      'querySchedulingWorkflow',
      Schema.Array(Schema.Unknown),
      ({ activities }) => activities.schedule('performSideEffect', []),
    ),
  )

  const output = await execute(executor, {
    workflowType: 'querySchedulingWorkflow',
    arguments: [],
    mode: 'query',
  })

  expect(output.completion).toBe('failed')
  expect(output.failure).toBeInstanceOf(Error)
  expect((output.failure as Error).message).toMatch(/Workflow query cannot emit new command/)
})

test('tampered determinism state throws WorkflowNondeterminismError', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow(
      'activityWorkflow',
      Schema.Array(Schema.Unknown),
      ({ activities }) => activities.schedule('sendEmail', ['hi'], { activityId: 'send-1', startToCloseTimeoutMs: 1000 }),
    ),
  )

  const first = await execute(executor, { workflowType: 'activityWorkflow', arguments: [] })
  expect(first.completion).toBe('pending')
  expect(first.determinismState.commandHistory.length).toBe(1)

  const tampered = cloneState(first.determinismState)
  const entry = tampered.commandHistory[0]
  if (entry?.intent.kind === 'schedule-activity') {
    tampered.commandHistory = [
      {
        ...entry,
        intent: {
          ...entry.intent,
          activityId: `${entry.intent.activityId}-tampered`,
        },
      },
    ]
  }

  await expect(
    execute(executor, {
      workflowType: 'activityWorkflow',
      arguments: [],
      determinismState: tampered,
    }),
  ).rejects.toBeInstanceOf(WorkflowNondeterminismError)
})

test('missing replay commands throws WorkflowNondeterminismError', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow(
      'timerWorkflow',
      Schema.Array(Schema.Unknown),
      ({ timers }) =>
        Effect.flatMap(
          timers.start({ timerId: 'timer-1', timeoutMs: 250 }),
          () => Effect.sync(() => 'ok'),
        ),
    ),
  )
  registry.register(
    defineWorkflow('noopWorkflow', Schema.Array(Schema.Unknown), () => Effect.sync(() => 'noop')),
  )

  const first = await execute(executor, { workflowType: 'timerWorkflow', arguments: [] })
  await expect(
    execute(executor, {
      workflowType: 'noopWorkflow',
      arguments: [],
      determinismState: cloneState(first.determinismState),
    }),
  ).rejects.toBeInstanceOf(WorkflowNondeterminismError)
})

test('workflow executor processes update invocations', async () => {
  const { registry, executor } = makeExecutor()
  const updateDefs = defineWorkflowUpdates([
    {
      name: 'setMessage',
      input: Schema.String,
      handler: (_ctx, value: string) => Effect.sync(() => value.toUpperCase()),
    },
  ])

  registry.register(
    defineWorkflow(
      'updateWorkflow',
      Schema.Array(Schema.Unknown),
      () => Effect.sync(() => 'ok'),
      { updates: updateDefs },
    ),
  )

  const output = await execute(executor, {
    workflowType: 'updateWorkflow',
    arguments: [],
    updates: [
      {
        protocolInstanceId: 'proto-1',
        requestMessageId: 'msg-1',
        updateId: 'upd-1',
        name: 'setMessage',
        payload: 'hello',
        identity: 'client',
        sequencingEventId: '5',
      } satisfies WorkflowUpdateInvocation,
    ],
  })

  expect(output.updateDispatches).toEqual([
    {
      type: 'acceptance',
      protocolInstanceId: 'proto-1',
      requestMessageId: 'msg-1',
      updateId: 'upd-1',
      handlerName: 'setMessage',
      identity: 'client',
      sequencingEventId: '5',
    },
    {
      type: 'completion',
      protocolInstanceId: 'proto-1',
      updateId: 'upd-1',
      status: 'success',
      result: 'HELLO',
      handlerName: 'setMessage',
      identity: 'client',
    },
  ])

  expect(output.determinismState.updates).toEqual([
    {
      updateId: 'upd-1',
      stage: 'admitted',
      handlerName: 'setMessage',
      identity: 'client',
      messageId: 'msg-1',
    },
    {
      updateId: 'upd-1',
      stage: 'accepted',
      handlerName: 'setMessage',
      identity: 'client',
      sequencingEventId: '5',
      messageId: 'msg-1',
    },
    {
      updateId: 'upd-1',
      stage: 'completed',
      handlerName: 'setMessage',
      identity: 'client',
      outcome: 'success',
      messageId: 'msg-1',
    },
  ])
})

test('workflow update logs are emitted once on replay', async () => {
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = []
  const logger: Logger = {
    log: (level, message, fields) =>
      Effect.sync(() => {
        logs.push({ level, message, fields: fields as Record<string, unknown> })
      }),
  }
  const { registry, executor } = makeExecutor(logger)
  const updateDefs = defineWorkflowUpdates([
    {
      name: 'emitLog',
      input: Schema.String,
      handler: (_ctx, value: string) =>
        Effect.sync(() => {
          log.info('update log', { value })
          return value.toUpperCase()
        }),
    },
  ])

  registry.register(
    defineWorkflow(
      'updateLogWorkflow',
      Schema.Array(Schema.Unknown),
      () => Effect.sync(() => 'ok'),
      { updates: updateDefs },
    ),
  )

  const invocation = {
    protocolInstanceId: 'proto-log',
    requestMessageId: 'msg-log',
    updateId: 'upd-log',
    name: 'emitLog',
    payload: 'hello',
    identity: 'client',
  } satisfies WorkflowUpdateInvocation

  const first = await execute(executor, {
    workflowType: 'updateLogWorkflow',
    arguments: [],
    updates: [invocation],
  })

  expect(first.completion).toBe('completed')
  expect(first.determinismState.logCount).toBe(1)
  expect(logs).toHaveLength(1)
  expect(logs[0]?.fields).toMatchObject({
    namespace: 'default',
    taskQueue: 'test-task-queue',
    workflowId: 'test-workflow-id',
    runId: 'test-run-id',
    workflowType: 'updateLogWorkflow',
    sdkComponent: 'workflow',
    value: 'hello',
  })

  const second = await execute(executor, {
    workflowType: 'updateLogWorkflow',
    arguments: [],
    determinismState: cloneState(first.determinismState),
    updates: [invocation],
  })

  expect(second.completion).toBe('completed')
  expect(logs).toHaveLength(1)
})

test('workflow executor processes update invocations even when workflow pending', async () => {

  const { registry, executor } = makeExecutor()
  const updateDefs = defineWorkflowUpdates([
    {
      name: 'setMessage',
      input: Schema.String,
      handler: (_ctx, value: string) => Effect.sync(() => value.toUpperCase()),
    },
  ])

  registry.register(
    defineWorkflow(
      'pendingUpdateWorkflow',
      Schema.Array(Schema.Unknown),
      ({ activities }) =>
        Effect.flatMap(
          activities.schedule('sendEmail', ['hello']),
          () => Effect.sync(() => 'done'),
        ),
      { updates: updateDefs },
    ),
  )

  const output = await execute(executor, {
    workflowType: 'pendingUpdateWorkflow',
    arguments: [],
    updates: [
      {
        protocolInstanceId: 'proto-3',
        requestMessageId: 'msg-3',
        updateId: 'upd-pending',
        name: 'setMessage',
        payload: 'pending',
        identity: 'client',
      } satisfies WorkflowUpdateInvocation,
    ],
  })

  expect(output.completion).toBe('pending')
  expect(output.updateDispatches).toEqual([
    {
      type: 'acceptance',
      protocolInstanceId: 'proto-3',
      requestMessageId: 'msg-3',
      updateId: 'upd-pending',
      handlerName: 'setMessage',
      identity: 'client',
      sequencingEventId: undefined,
    },
    {
      type: 'completion',
      protocolInstanceId: 'proto-3',
      updateId: 'upd-pending',
      status: 'success',
      result: 'PENDING',
      handlerName: 'setMessage',
      identity: 'client',
    },
  ])

  expect(output.determinismState.updates).toEqual([
    {
      updateId: 'upd-pending',
      stage: 'admitted',
      handlerName: 'setMessage',
      identity: 'client',
      messageId: 'msg-3',
    },
    {
      updateId: 'upd-pending',
      stage: 'accepted',
      handlerName: 'setMessage',
      identity: 'client',
      sequencingEventId: undefined,
      messageId: 'msg-3',
    },
    {
      updateId: 'upd-pending',
      stage: 'completed',
      handlerName: 'setMessage',
      identity: 'client',
      outcome: 'success',
      messageId: 'msg-3',
    },
  ])
})

test('workflow executor rejects unknown update handlers', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow('noUpdates', Schema.Array(Schema.Unknown), () => Effect.sync(() => 'ok')),
  )

  const output = await execute(executor, {
    workflowType: 'noUpdates',
    arguments: [],
    updates: [
      {
        protocolInstanceId: 'proto-2',
        requestMessageId: 'msg-2',
        updateId: 'upd-404',
        name: 'unknownUpdate',
        payload: {},
      } satisfies WorkflowUpdateInvocation,
    ],
  })

  expect(output.updateDispatches).toEqual([
    {
      type: 'rejection',
      protocolInstanceId: 'proto-2',
      requestMessageId: 'msg-2',
      updateId: 'upd-404',
      reason: 'handler-not-found',
      failure: expect.any(Error),
      sequencingEventId: undefined,
    },
  ])

  expect(output.determinismState.updates).toEqual([
    {
      updateId: 'upd-404',
      stage: 'admitted',
      handlerName: 'unknownUpdate',
      messageId: 'msg-2',
    },
    {
      updateId: 'upd-404',
      stage: 'rejected',
      handlerName: 'unknownUpdate',
      failureMessage: 'Workflow update handler "unknownUpdate" was not found',
      messageId: 'msg-2',
    },
  ])
})

const cloneState = (state: WorkflowDeterminismState): WorkflowDeterminismState => ({
  commandHistory: state.commandHistory.map((entry) => ({
    intent: entry.intent,
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  })),
  randomValues: [...state.randomValues],
  timeValues: [...state.timeValues],
  ...(state.logCount !== undefined ? { logCount: state.logCount } : {}),
  failureMetadata: state.failureMetadata ? { ...state.failureMetadata } : undefined,
  signals: state.signals ? state.signals.map((record) => ({ ...record })) : [],
  queries: state.queries ? state.queries.map((record) => ({ ...record })) : [],
  ...(state.updates ? { updates: state.updates.map((entry) => ({ ...entry })) } : {}),
})
