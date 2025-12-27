import { expect, test } from 'bun:test'
import type {
  ActivityResolution,
  Command,
  ExecuteWorkflowInput,
  WorkflowDefinitions,
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
          repositoryId: 'repo-id',
          fileKeyId: 'file-key-id',
          fileVersionId: 'file-version-id',
        },
      },
    ],
    [
      'activity-5',
      {
        status: 'completed',
        value: {
          enrichmentId: 'enrichment-id',
        },
      },
    ],
    [
      'activity-6',
      {
        status: 'completed',
        value: {},
      },
    ],
    [
      'activity-7',
      {
        status: 'completed',
        value: {},
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

  expect(scheduleCommands).toHaveLength(8)
  expect(output.commands.at(-1)?.commandType).toBe(CommandType.COMPLETE_WORKFLOW_EXECUTION)
  expect(output.completion).toBe('completed')
  expect(output.result).toEqual({ id: 'enrichment-id', filename: input.filePath })
})

test('enrichFile falls back when enrichWithModel times out', async () => {
  const { executor, dataConverter } = makeExecutor()
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
        status: 'failed',
        error: new Error('completion request timed out after 60000ms'),
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
          repositoryId: 'repo-id',
          fileKeyId: 'file-key-id',
          fileVersionId: 'file-version-id',
        },
      },
    ],
    [
      'activity-5',
      {
        status: 'completed',
        value: {
          enrichmentId: 'enrichment-id',
        },
      },
    ],
    [
      'activity-6',
      {
        status: 'completed',
        value: {},
      },
    ],
    [
      'activity-7',
      {
        status: 'completed',
        value: {},
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
  const persistCommand = scheduleCommands.find((command) => {
    if (command.attributes?.case !== 'scheduleActivityTaskCommandAttributes') {
      return false
    }
    return command.attributes.value.activityType?.name === 'persistEnrichmentRecord'
  })

  expect(output.completion).toBe('completed')
  expect(persistCommand).toBeDefined()
  if (persistCommand?.attributes?.case !== 'scheduleActivityTaskCommandAttributes') {
    throw new Error('Expected persistEnrichmentRecord command attributes.')
  }
  const decoded = await decodePayloadsToValues(dataConverter, persistCommand.attributes.value.input?.payloads ?? [])
  const record = decoded?.[0] as { summary?: string } | undefined
  expect(record?.summary ?? '').toContain('model timeout')
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
          enrichmentId: 'enrichment-id',
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
        value: {},
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

  expect(scheduleCommands).toHaveLength(9)
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
  expect(childCommands).toHaveLength(files.length)
  const childAttrs =
    childCommands[0]?.attributes?.case === 'startChildWorkflowExecutionCommandAttributes'
      ? childCommands[0].attributes.value
      : undefined
  expect(childAttrs?.parentClosePolicy).toBe(PARENT_CLOSE_POLICY_ABANDON)
  expect(output.completion).toBe('pending')
})

test('enrichRepository keeps 50 child workflows in flight', async () => {
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
  expect(initialChildCommands).toHaveLength(50)
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
  expect(nextChildAttrs?.workflowId).toBe(`${workflowId}-child-${runId}-50`)
  expect(next.completion).toBe('pending')
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
