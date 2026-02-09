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

test('enrichFile schedules ingestion when event delivery is provided', async () => {
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
  expect(attrs?.activityType?.name).toBe('upsertIngestion')

  const decoded = await decodePayloadsToValues(dataConverter, attrs?.input?.payloads ?? [])
  expect(decoded).toEqual([
    {
      deliveryId: input.eventDeliveryId,
      workflowId: 'test-workflow-id',
      status: 'running',
    },
  ])
})

test('enrichFile does not mark ingestion failed when blocked on readRepoFile', async () => {
  const { executor } = makeExecutor()
  const input = {
    repoRoot: '/workspace/lab/.worktrees/bumba',
    filePath: 'apps/froussard/src/webhooks/github.ts',
    context: 'unit-test',
    eventDeliveryId: 'delivery-1',
  }

  const determinismState: WorkflowDeterminismState = {
    commandHistory: [
      {
        intent: {
          id: 'schedule-activity-0',
          kind: 'schedule-activity',
          sequence: 0,
          activityType: 'upsertIngestion',
          activityId: 'activity-0',
          taskQueue: 'bumba',
          input: [
            {
              deliveryId: input.eventDeliveryId,
              workflowId: 'test-workflow-id',
              status: 'running',
            },
          ],
          timeouts: {
            scheduleToCloseTimeoutMs: 120_000,
            startToCloseTimeoutMs: 30_000,
          },
          retry: {
            initialIntervalMs: 2_000,
            backoffCoefficient: 2,
            maximumIntervalMs: 30_000,
            maximumAttempts: 4,
          },
          requestEagerExecution: undefined,
        },
      },
    ],
    randomValues: [],
    timeValues: [],
    signals: [],
    queries: [],
  }

  const activityResults = new Map<string, ActivityResolution>([
    [
      'activity-0',
      {
        status: 'completed',
        value: {
          ingestionId: 'ingestion-id',
        },
      },
    ],
  ])

  const output = await execute(executor, {
    workflowType: 'enrichFile',
    arguments: input,
    determinismState,
    activityResults,
  })

  expect(output.completion).toBe('pending')
  expect(output.commands).toHaveLength(1)
  const schedule = output.commands[0]
  expect(schedule.commandType).toBe(CommandType.SCHEDULE_ACTIVITY_TASK)
  if (schedule.attributes?.case !== 'scheduleActivityTaskCommandAttributes') {
    throw new Error('Expected schedule activity attributes on readRepoFile command.')
  }
  expect(schedule.attributes.value.activityType?.name).toBe('readRepoFile')
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
          ingestionId: 'ingestion-id',
          eventId: 'event-id',
        },
      },
    ],
    [
      'activity-1',
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
          repositoryId: 'repo-id',
          fileKeyId: 'file-key-id',
          fileVersionId: 'file-version-id',
        },
      },
    ],
    [
      'activity-6',
      {
        status: 'completed',
        value: {
          eventFileId: 'event-file-id',
          eventId: 'event-id',
          fileKeyId: 'file-key-id',
        },
      },
    ],
    [
      'activity-7',
      {
        status: 'completed',
        value: {},
      },
    ],
    [
      'activity-8',
      {
        status: 'completed',
        value: {
          enrichmentId: 'enrichment-id',
        },
      },
    ],
    [
      'activity-9',
      {
        status: 'completed',
        value: {},
      },
    ],
    [
      'activity-10',
      {
        status: 'completed',
        value: {
          skipped: true,
          reason: 'disabled',
          chunks: 0,
          embedded: 0,
        },
      },
    ],
    [
      'activity-11',
      {
        status: 'completed',
        value: {},
      },
    ],
    [
      'activity-12',
      {
        status: 'completed',
        value: {
          ingestionId: 'ingestion-id',
          eventId: 'event-id',
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

  expect(scheduleCommands).toHaveLength(13)
  expect(output.commands.at(-1)?.commandType).toBe(CommandType.COMPLETE_WORKFLOW_EXECUTION)
  expect(output.completion).toBe('completed')
  expect(output.result).toEqual({ id: 'enrichment-id', filename: input.filePath })
})

test('enrichFile fails when enrichWithModel times out', async () => {
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
          ingestionId: 'ingestion-id',
          eventId: 'event-id',
        },
      },
    ],
    [
      'activity-1',
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
        status: 'failed',
        error: new Error('completion request timed out after 60000ms'),
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
          repositoryId: 'repo-id',
          fileKeyId: 'file-key-id',
          fileVersionId: 'file-version-id',
        },
      },
    ],
    [
      'activity-6',
      {
        status: 'completed',
        value: {
          eventFileId: 'event-file-id',
          eventId: 'event-id',
          fileKeyId: 'file-key-id',
        },
      },
    ],
    [
      'activity-7',
      {
        status: 'completed',
        value: {},
      },
    ],
    [
      'activity-8',
      {
        status: 'completed',
        value: {
          enrichmentId: 'enrichment-id',
        },
      },
    ],
    [
      'activity-9',
      {
        status: 'completed',
        value: {},
      },
    ],
    [
      'activity-10',
      {
        status: 'completed',
        value: {},
      },
    ],
    [
      'activity-11',
      {
        status: 'completed',
        value: {
          ingestionId: 'ingestion-id',
          eventId: 'event-id',
        },
      },
    ],
  ])

  const output = await execute(executor, {
    workflowType: 'enrichFile',
    arguments: input,
    activityResults,
  })

  expect(output.completion).toBe('failed')
  expect(output.failure).toBeInstanceOf(Error)
  expect((output.failure as Error).message).toContain('completion request timed out')
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
          ingestionId: 'ingestion-id',
          eventId: 'event-id',
        },
      },
    ],
    [
      'activity-1',
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
      'activity-2',
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
      'activity-3',
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
      'activity-4',
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
      'activity-5',
      {
        status: 'completed',
        value: {
          embedding: [0.1, 0.2, 0.3],
        },
      },
    ],
    [
      'activity-6',
      {
        status: 'completed',
        value: {
          repositoryId: 'repo-id',
          fileKeyId: 'file-key-id',
          fileVersionId: 'file-version-id',
        },
      },
    ],
    [
      'activity-7',
      {
        status: 'completed',
        value: {
          eventFileId: 'event-file-id',
          eventId: 'event-id',
          fileKeyId: 'file-key-id',
        },
      },
    ],
    [
      'activity-8',
      {
        status: 'completed',
        value: {},
      },
    ],
    [
      'activity-9',
      {
        status: 'completed',
        value: {
          enrichmentId: 'enrichment-id',
        },
      },
    ],
    [
      'activity-10',
      {
        status: 'completed',
        value: {},
      },
    ],
    [
      'activity-11',
      {
        status: 'completed',
        value: {
          skipped: true,
          reason: 'disabled',
          chunks: 0,
          embedded: 0,
        },
      },
    ],
    [
      'activity-12',
      {
        status: 'completed',
        value: {},
      },
    ],
    [
      'activity-13',
      {
        status: 'completed',
        value: {
          ingestionId: 'ingestion-id',
          eventId: 'event-id',
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

  expect(scheduleCommands).toHaveLength(14)
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
    maxFiles: 12,
  }

  const files = Array.from({ length: 12 }, (_value, index) => `services/file-${index}.ts`)

  const activityResults = new Map<string, ActivityResolution>([
    [
      'activity-0',
      {
        status: 'completed',
        value: {
          files,
          total: files.length,
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
  expect(childCommands).toHaveLength(12)
  const childAttrs =
    childCommands[0]?.attributes?.case === 'startChildWorkflowExecutionCommandAttributes'
      ? childCommands[0].attributes.value
      : undefined
  expect(childAttrs?.parentClosePolicy).toBe(PARENT_CLOSE_POLICY_ABANDON)
  expect(output.completion).toBe('pending')
})

test('enrichRepository keeps 24 child workflows in flight', async () => {
  const { executor } = makeExecutor()
  const files = Array.from({ length: 52 }, (_value, index) => `path/to/file-${index}.ts`)
  const input = {
    repoRoot: '/workspace/lab/.worktrees/bumba',
    repository: 'proompteng/lab',
    files,
  }
  const workflowId = 'repo-workflow'
  const runId = 'run-1'

  const initial = await execute(executor, {
    workflowType: 'enrichRepository',
    arguments: input,
    workflowId,
    runId,
  })

  const initialChildCommands = initial.commands.filter(
    (command: Command) => command.commandType === CommandType.START_CHILD_WORKFLOW_EXECUTION,
  )
  expect(initialChildCommands).toHaveLength(24)
  expect(initial.completion).toBe('pending')

  const signalDeliveries = [
    {
      name: '__childWorkflowCompleted',
      args: [
        {
          workflowId: `${workflowId}-child-${runId}-0`,
          status: 'completed',
        },
      ],
    },
  ]

  const next = await execute(executor, {
    workflowType: 'enrichRepository',
    arguments: input,
    workflowId,
    runId,
    determinismState: initial.determinismState,
    signalDeliveries,
  })

  const nextChildCommands = next.commands.filter(
    (command: Command) => command.commandType === CommandType.START_CHILD_WORKFLOW_EXECUTION,
  )
  expect(nextChildCommands).toHaveLength(1)
  const nextChildAttrs =
    nextChildCommands[0]?.attributes?.case === 'startChildWorkflowExecutionCommandAttributes'
      ? nextChildCommands[0].attributes.value
      : undefined
  expect(nextChildAttrs?.workflowId).toBe(`${workflowId}-child-${runId}-24`)
  expect(next.completion).toBe('pending')
})

test('enrichRepository respects child workflow concurrency overrides', async () => {
  const { executor } = makeExecutor()
  const files = Array.from({ length: 20 }, (_value, index) => `path/to/file-${index}.ts`)
  const input = {
    repoRoot: '/workspace/lab/.worktrees/bumba',
    repository: 'proompteng/lab',
    files,
    childWorkflowConcurrency: 6,
  }
  const workflowId = 'repo-workflow-override'
  const runId = 'run-override'

  const initial = await execute(executor, {
    workflowType: 'enrichRepository',
    arguments: input,
    workflowId,
    runId,
  })

  const initialChildCommands = initial.commands.filter(
    (command: Command) => command.commandType === CommandType.START_CHILD_WORKFLOW_EXECUTION,
  )
  expect(initialChildCommands).toHaveLength(6)
  expect(initial.completion).toBe('pending')

  const signalDeliveries = [
    {
      name: '__childWorkflowCompleted',
      args: [
        {
          workflowId: `${workflowId}-child-${runId}-0`,
          status: 'completed',
        },
      ],
    },
  ]

  const next = await execute(executor, {
    workflowType: 'enrichRepository',
    arguments: input,
    workflowId,
    runId,
    determinismState: initial.determinismState,
    signalDeliveries,
  })

  const nextChildCommands = next.commands.filter(
    (command: Command) => command.commandType === CommandType.START_CHILD_WORKFLOW_EXECUTION,
  )
  expect(nextChildCommands).toHaveLength(1)
  const nextChildAttrs =
    nextChildCommands[0]?.attributes?.case === 'startChildWorkflowExecutionCommandAttributes'
      ? nextChildCommands[0].attributes.value
      : undefined
  expect(nextChildAttrs?.workflowId).toBe(`${workflowId}-child-${runId}-6`)
  expect(next.completion).toBe('pending')
})

test('enrichRepository uses maxFiles as the default child workflow concurrency', async () => {
  const { executor } = makeExecutor()
  const files = Array.from({ length: 20 }, (_value, index) => `path/to/file-${index}.ts`)
  const input = {
    repoRoot: '/workspace/lab/.worktrees/bumba',
    repository: 'proompteng/lab',
    files,
    maxFiles: 6,
  }
  const workflowId = 'repo-workflow-maxfiles'
  const runId = 'run-maxfiles'

  const initial = await execute(executor, {
    workflowType: 'enrichRepository',
    arguments: input,
    workflowId,
    runId,
  })

  const initialChildCommands = initial.commands.filter(
    (command: Command) => command.commandType === CommandType.START_CHILD_WORKFLOW_EXECUTION,
  )
  expect(initialChildCommands).toHaveLength(6)
  expect(initial.completion).toBe('pending')
})

test('enrichRepository completes when child workflows signal completion', async () => {
  const { executor } = makeExecutor()
  const files = ['path/to/file-0.ts', 'path/to/file-1.ts', 'path/to/file-2.ts']
  const input = {
    repoRoot: '/workspace/lab/.worktrees/bumba',
    repository: 'proompteng/lab',
    files,
  }
  const workflowId = 'repo-workflow'
  const runId = 'run-1'

  const initial = await execute(executor, {
    workflowType: 'enrichRepository',
    arguments: input,
    workflowId,
    runId,
  })

  const childCommands = initial.commands.filter(
    (command: Command) => command.commandType === CommandType.START_CHILD_WORKFLOW_EXECUTION,
  )

  expect(childCommands).toHaveLength(files.length)
  expect(initial.completion).toBe('pending')

  const signalDeliveries = files.map((_filePath, index) => ({
    name: '__childWorkflowCompleted',
    args: [
      {
        workflowId: `${workflowId}-child-${runId}-${index}`,
        status: 'completed',
      },
    ],
  }))

  const completion = await execute(executor, {
    workflowType: 'enrichRepository',
    arguments: input,
    workflowId,
    runId,
    determinismState: initial.determinismState,
    signalDeliveries,
    pendingChildWorkflows: new Set(),
  })

  expect(completion.completion).toBe('completed')
  expect(completion.result).toEqual({
    total: files.length,
    skipped: 0,
    queued: files.length,
    completed: files.length,
    failed: 0,
  })
})

test('enrichRepository fails when child workflows report failures', async () => {
  const { executor } = makeExecutor()
  const files = ['path/to/file-0.ts', 'path/to/file-1.ts']
  const input = {
    repoRoot: '/workspace/lab/.worktrees/bumba',
    repository: 'proompteng/lab',
    files,
  }
  const workflowId = 'repo-workflow'
  const runId = 'run-2'

  const initial = await execute(executor, {
    workflowType: 'enrichRepository',
    arguments: input,
    workflowId,
    runId,
  })

  expect(initial.completion).toBe('pending')

  const signalDeliveries = [
    {
      name: '__childWorkflowCompleted',
      args: [
        {
          workflowId: `${workflowId}-child-${runId}-0`,
          status: 'completed',
        },
      ],
    },
    {
      name: '__childWorkflowCompleted',
      args: [
        {
          workflowId: `${workflowId}-child-${runId}-1`,
          status: 'failed',
        },
      ],
    },
  ]

  const completion = await execute(executor, {
    workflowType: 'enrichRepository',
    arguments: input,
    workflowId,
    runId,
    determinismState: initial.determinismState,
    signalDeliveries,
    pendingChildWorkflows: new Set(),
  })

  expect(completion.completion).toBe('failed')
  expect(completion.failure).toBeInstanceOf(Error)
  expect((completion.failure as Error).message).toContain('1 child workflows failed')
})
