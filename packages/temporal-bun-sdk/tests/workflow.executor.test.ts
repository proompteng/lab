import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { createDefaultDataConverter, decodePayloadsToValues } from '../src/common/payloads'
import type { ExecuteWorkflowInput, WorkflowExecutionOutput } from '../src/workflow/executor'
import { WorkflowExecutor } from '../src/workflow/executor'
import { defineWorkflow } from '../src/workflow/definition'
import { WorkflowRegistry } from '../src/workflow/registry'
import { WorkflowNondeterminismError } from '../src/workflow/errors'
import type { WorkflowDeterminismState } from '../src/workflow/determinism'
import { CommandType } from '../src/proto/temporal/api/enums/v1/command_type_pb'

const makeExecutor = () => {
  const registry = new WorkflowRegistry()
  const dataConverter = createDefaultDataConverter()
  const executor = new WorkflowExecutor({ registry, dataConverter })
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
    bypassDeterministicContext: overrides.bypassDeterministicContext,
  })

test('schedules an activity command and completes with result', async () => {
  const { registry, executor, dataConverter } = makeExecutor()
  registry.register(
    defineWorkflow(
      'scheduleActivity',
      Schema.Array(Schema.String),
      ({ input, activities }) =>
        Effect.flatMap(activities.schedule('sendEmail', input), () => Effect.sync(() => 'scheduled')),
    ),
  )

  const output = await execute(executor, { workflowType: 'scheduleActivity', arguments: ['hello@acme.test'] })

  expect(output.commands).toHaveLength(2)
  const [schedule, completion] = output.commands
  expect(schedule.commandType).toBe(CommandType.SCHEDULE_ACTIVITY_TASK)
  expect(schedule.attributes?.case).toBe('scheduleActivityTaskCommandAttributes')
  const attrs = schedule.attributes?.value
  expect(attrs?.activityType?.name).toBe('sendEmail')
  expect(attrs?.activityId).toBe('activity-0')
  const decoded = await decodePayloadsToValues(dataConverter, attrs?.input?.payloads ?? [])
  expect(decoded).toEqual(['hello@acme.test'])

  expect(completion.commandType).toBe(CommandType.COMPLETE_WORKFLOW_EXECUTION)
  expect(output.completion).toBe('completed')
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

  expect(output.commands).toHaveLength(2)
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

  expect(output.commands).toHaveLength(2)
  const startChildCommand = output.commands[0]
  expect(startChildCommand.commandType).toBe(CommandType.START_CHILD_WORKFLOW_EXECUTION)
  expect(startChildCommand.attributes?.case).toBe('startChildWorkflowExecutionCommandAttributes')
  const attrs = startChildCommand.attributes?.value
  expect(attrs?.workflowType?.name).toBe('childWorkflow')
  expect(attrs?.workflowId).toBe('child-1')
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

test('tampered determinism state throws WorkflowNondeterminismError', async () => {
  const { registry, executor } = makeExecutor()
  registry.register(
    defineWorkflow(
      'randomWorkflow',
      Schema.Array(Schema.Unknown),
      ({ determinism }) =>
        Effect.sync(() => determinism.random()),
    ),
  )

  const first = await execute(executor, { workflowType: 'randomWorkflow', arguments: [] })
  expect(first.completion).toBe('completed')
  expect(first.determinismState.randomValues.length).toBe(1)

  const tampered = cloneState(first.determinismState)
  tampered.randomValues = []

  await expect(
    execute(executor, {
      workflowType: 'randomWorkflow',
      arguments: [],
      determinismState: tampered,
    }),
  ).rejects.toBeInstanceOf(WorkflowNondeterminismError)
})

const cloneState = (state: WorkflowDeterminismState): WorkflowDeterminismState => ({
  commandHistory: state.commandHistory.map((entry) => ({ intent: entry.intent })),
  randomValues: [...state.randomValues],
  timeValues: [...state.timeValues],
})
