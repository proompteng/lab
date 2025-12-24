import { expect, test } from 'bun:test'
import type {
  ActivityResolution,
  Command,
  ExecuteWorkflowInput,
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

type ExecuteOverrides = Partial<ExecuteWorkflowInput> & Pick<ExecuteWorkflowInput, 'workflowType' | 'arguments'>

const makeExecutor = () => {
  const registry = new WorkflowRegistry()
  const dataConverter = createDefaultDataConverter()
  const executor = new WorkflowExecutor({ registry, dataConverter })
  for (const workflow of workflows) {
    registry.register(workflow)
  }
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
    [
      'activity-5',
      {
        status: 'completed',
        value: null,
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
