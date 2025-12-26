import { expect, test } from 'bun:test'
import type {
  ActivityResolution,
  Command,
  ExecuteWorkflowInput,
  WorkflowDefinitions,
  WorkflowDeterminismState,
  WorkflowExecutionOutput,
} from '@proompteng/temporal-bun-sdk/workflow'
import {
  CommandType,
  createDefaultDataConverter,
  decodePayloadsToValues,
  WorkflowExecutor,
  WorkflowRegistry,
} from '@proompteng/temporal-bun-sdk/workflow'

import { workflows } from './index'

const PARENT_CLOSE_POLICY_ABANDON = 2

type ExecuteOverrides = Partial<ExecuteWorkflowInput> & Pick<ExecuteWorkflowInput, 'workflowType' | 'arguments'>

const makeExecutor = () => {
  const registry = new WorkflowRegistry()
  const dataConverter = createDefaultDataConverter()
  const executor = new WorkflowExecutor({ registry, dataConverter })
  registry.registerMany(workflows as WorkflowDefinitions)
  return { registry, executor, dataConverter }
}

const execute = async (executor: WorkflowExecutor, overrides: ExecuteOverrides): Promise<WorkflowExecutionOutput> =>
  await executor.execute({
    workflowType: overrides.workflowType,
    arguments: overrides.arguments,
    workflowId: overrides.workflowId ?? 'test-workflow-id',
    runId: overrides.runId ?? 'test-run-id',
    namespace: overrides.namespace ?? 'default',
    taskQueue: overrides.taskQueue ?? 'bumba',
    determinismState: overrides.determinismState,
    activityResults: overrides.activityResults,
    activityScheduleEventIds: overrides.activityScheduleEventIds,
    pendingChildWorkflows: overrides.pendingChildWorkflows,
    signalDeliveries: overrides.signalDeliveries,
    timerResults: overrides.timerResults,
    updates: overrides.updates,
    mode: overrides.mode,
  })

test('enrichFile schedules the first activity and blocks', async () => {
  const { executor, dataConverter } = makeExecutor()
  const input = {
    repoRoot: '/workspace/lab/.worktrees/bumba',
    filePath: 'apps/froussard/src/webhooks/github.ts',
    context: 'unit-test',
    eventDeliveryId: 'delivery-1',
  }

  const output = await execute(executor, { workflowType: 'enrichFile', arguments: input })

  expect(output.completion).toBe('pending')
  expect(output.commands).toHaveLength(1)
  const schedule = output.commands[0]
  expect(schedule.commandType).toBe(CommandType.SCHEDULE_ACTIVITY_TASK)
  if (schedule.attributes?.case !== 'scheduleActivityTaskCommandAttributes') {
    throw new Error('Expected schedule activity attributes on first command.')
  }
  const attrs = schedule.attributes.value
  expect(attrs?.activityType?.name).toBe('readRepoFile')
  expect(attrs?.activityId).toBe('activity-0')

  const decoded = await decodePayloadsToValues(dataConverter, attrs?.input?.payloads ?? [])
  expect(decoded).toEqual([
    {
      repoRoot: input.repoRoot,
      filePath: input.filePath,
    },
  ])
})

test('enrichFile completes when all activities are resolved', async () => {
  const { executor } = makeExecutor()
  const input = {
    repoRoot: '/workspace/lab/.worktrees/bumba',
    filePath: 'apps/froussard/src/webhooks/github.ts',
    context: 'unit-test',
    eventDeliveryId: 'delivery-1',
  }

  const activityResults = new Map<string, ActivityResolution>([
    [
      'activity-0',
      {
        status: 'completed',
        value: {
          content: 'console.log("hi")',
          metadata: {
            repoName: 'lab',
            repoRef: 'main',
            repoCommit: 'deadbeef',
            path: input.filePath,
            contentHash: 'hash',
            language: 'ts',
            byteSize: 17,
            lineCount: 1,
            sourceTimestamp: null,
            metadata: {},
          },
        },
      },
    ],
    [
      'activity-1',
      {
        status: 'completed',
        value: {
          astSummary: 'summary',
          facts: [],
          metadata: {},
        },
      },
    ],
    [
      'activity-2',
      {
        status: 'completed',
        value: {
          summary: 'short summary',
          enriched: '- bullet',
          metadata: {},
        },
      },
    ],
    [
      'activity-3',
      {
        status: 'completed',
        value: {
          embedding: [0.1, 0.2, 0.3],
        },
      },
    ],
    [
      'activity-4',
      {
        status: 'completed',
        value: {
          id: 'enrichment-id',
        },
      },
    ],
  ])

  const output = await execute(executor, {
    workflowType: 'enrichFile',
    arguments: input,
    activityResults,
  })

  const scheduleCommands = output.commands.filter(
    (command: Command) => command.commandType === CommandType.SCHEDULE_ACTIVITY_TASK,
  )

  expect(scheduleCommands).toHaveLength(5)
  expect(output.commands.at(-1)?.commandType).toBe(CommandType.COMPLETE_WORKFLOW_EXECUTION)
  expect(output.completion).toBe('completed')
  expect(output.result).toEqual({ id: 'enrichment-id', filename: input.filePath })
})

test('enrichFile schedules cleanup when force is enabled', async () => {
  const { executor } = makeExecutor()
  const input = {
    repoRoot: '/workspace/lab/.worktrees/bumba',
    filePath: 'apps/froussard/src/webhooks/github.ts',
    context: 'unit-test',
    eventDeliveryId: 'delivery-1',
    force: true,
  }

  const activityResults = new Map<string, ActivityResolution>([
    [
      'activity-0',
      {
        status: 'completed',
        value: {
          content: 'console.log("hi")',
          metadata: {
            repoName: 'lab',
            repoRef: 'main',
            repoCommit: 'deadbeef',
            path: input.filePath,
            contentHash: 'hash',
            language: 'ts',
            byteSize: 17,
            lineCount: 1,
            sourceTimestamp: null,
            metadata: {},
          },
        },
      },
    ],
    [
      'activity-1',
      {
        status: 'completed',
        value: {
          fileVersions: 1,
          enrichments: 1,
          embeddings: 1,
          facts: 0,
        },
      },
    ],
    [
      'activity-2',
      {
        status: 'completed',
        value: {
          astSummary: 'summary',
          facts: [],
          metadata: {},
        },
      },
    ],
    [
      'activity-3',
      {
        status: 'completed',
        value: {
          summary: 'short summary',
          enriched: '- bullet',
          metadata: {},
        },
      },
    ],
    [
      'activity-4',
      {
        status: 'completed',
        value: {
          embedding: [0.1, 0.2, 0.3],
        },
      },
    ],
    [
      'activity-5',
      {
        status: 'completed',
        value: {
          id: 'enrichment-id',
        },
      },
    ],
  ])

  const output = await execute(executor, {
    workflowType: 'enrichFile',
    arguments: input,
    activityResults,
  })

  const scheduleCommands = output.commands.filter(
    (command: Command) => command.commandType === CommandType.SCHEDULE_ACTIVITY_TASK,
  )

  expect(scheduleCommands).toHaveLength(6)
  expect(output.commands.at(-1)?.commandType).toBe(CommandType.COMPLETE_WORKFLOW_EXECUTION)
  expect(output.completion).toBe('completed')
  expect(output.result).toEqual({ id: 'enrichment-id', filename: input.filePath })
})

test('enrichRepository schedules listing and child workflows', async () => {
  const { executor, dataConverter } = makeExecutor()
  const input = {
    repoRoot: '/workspace/lab/.worktrees/bumba',
    repository: 'proompteng/lab',
    ref: 'main',
    commit: 'deadbeef',
    pathPrefix: 'services',
    maxFiles: 10,
  }

  const activityResults = new Map<string, ActivityResolution>([
    [
      'activity-0',
      {
        status: 'completed',
        value: {
          files: ['services/bumba/src/worker.ts', 'services/jangar/src/server/bumba.ts'],
          total: 2,
          skipped: 0,
        },
      },
    ],
  ])

  const output = await execute(executor, {
    workflowType: 'enrichRepository',
    arguments: input,
    activityResults,
  })

  const scheduleCommands = output.commands.filter(
    (command: Command) => command.commandType === CommandType.SCHEDULE_ACTIVITY_TASK,
  )
  expect(scheduleCommands).toHaveLength(1)
  const schedule = scheduleCommands[0]
  if (schedule.attributes?.case !== 'scheduleActivityTaskCommandAttributes') {
    throw new Error('Expected schedule activity attributes for repository listing.')
  }

  const decoded = await decodePayloadsToValues(dataConverter, schedule.attributes.value.input?.payloads ?? [])
  expect(decoded).toEqual([
    {
      repoRoot: input.repoRoot,
      ref: input.commit,
      pathPrefix: input.pathPrefix,
      maxFiles: input.maxFiles,
    },
  ])

  const childCommands = output.commands.filter(
    (command: Command) => command.commandType === CommandType.START_CHILD_WORKFLOW_EXECUTION,
  )
  expect(childCommands).toHaveLength(2)
  const childAttrs =
    childCommands[0]?.attributes?.case === 'startChildWorkflowExecutionCommandAttributes'
      ? childCommands[0].attributes.value
      : undefined
  expect(childAttrs?.parentClosePolicy).toBe(PARENT_CLOSE_POLICY_ABANDON)
  expect(output.completion).toBe('pending')

  const completionRun = await execute(executor, {
    workflowType: 'enrichRepository',
    arguments: input,
    determinismState: cloneState(output.determinismState),
    activityResults,
    pendingChildWorkflows: new Set(),
  })

  expect(completionRun.completion).toBe('completed')
  expect(completionRun.commands).toHaveLength(1)
  expect(completionRun.commands[0]?.commandType).toBe(CommandType.COMPLETE_WORKFLOW_EXECUTION)
})

test('enrichRepository continues as new when file list exceeds batch size', async () => {
  const { executor } = makeExecutor()
  const batchSize = 50
  const files = Array.from({ length: batchSize + 1 }, (_value, index) => `path/to/file-${index}.ts`)
  const input = {
    repoRoot: '/workspace/lab/.worktrees/bumba',
    repository: 'proompteng/lab',
    files,
  }

  const output = await execute(executor, {
    workflowType: 'enrichRepository',
    arguments: input,
  })

  const continueCommands = output.commands.filter(
    (command: Command) => command.commandType === CommandType.CONTINUE_AS_NEW_WORKFLOW_EXECUTION,
  )
  const childCommands = output.commands.filter(
    (command: Command) => command.commandType === CommandType.START_CHILD_WORKFLOW_EXECUTION,
  )

  expect(output.completion).toBe('pending')
  expect(continueCommands).toHaveLength(0)
  expect(childCommands).toHaveLength(batchSize)

  const continuationRun = await execute(executor, {
    workflowType: 'enrichRepository',
    arguments: input,
    determinismState: cloneState(output.determinismState),
    pendingChildWorkflows: new Set(),
  })

  const continuationCommands = continuationRun.commands.filter(
    (command: Command) => command.commandType === CommandType.CONTINUE_AS_NEW_WORKFLOW_EXECUTION,
  )
  const continuationChildCommands = continuationRun.commands.filter(
    (command: Command) => command.commandType === CommandType.START_CHILD_WORKFLOW_EXECUTION,
  )

  expect(continuationRun.completion).toBe('continued-as-new')
  expect(continuationCommands).toHaveLength(1)
  expect(continuationChildCommands).toHaveLength(0)
})

const cloneState = (state: WorkflowDeterminismState): WorkflowDeterminismState => ({
  commandHistory: state.commandHistory.map((entry) => ({
    intent: entry.intent,
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  })),
  randomValues: [...state.randomValues],
  timeValues: [...state.timeValues],
  failureMetadata: state.failureMetadata ? { ...state.failureMetadata } : undefined,
  signals: state.signals ? state.signals.map((record) => ({ ...record })) : [],
  queries: state.queries ? state.queries.map((record) => ({ ...record })) : [],
  ...(state.updates ? { updates: state.updates.map((entry) => ({ ...entry })) } : {}),
})
