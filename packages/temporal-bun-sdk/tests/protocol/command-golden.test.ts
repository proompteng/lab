import { expect, test } from 'bun:test'

import { createDefaultDataConverter } from '../../src/common/payloads'
import { CommandType } from '../../src/proto/temporal/api/enums/v1/command_type_pb'
import { materializeCommands, type WorkflowCommandIntent } from '../../src/workflow/commands'
import type { WorkflowInfo } from '../../src/workflow/context'

const workflowInfo: WorkflowInfo = {
  namespace: 'default',
  taskQueue: 'golden-task-queue',
  workflowId: 'golden-workflow-id',
  runId: 'golden-run-id',
  workflowType: 'goldenWorkflow',
}

const dataConverter = createDefaultDataConverter()

test('materializes stable command projections for core workflow intents', async () => {
  const intents: WorkflowCommandIntent[] = [
    {
      id: 'schedule-activity-0',
      kind: 'schedule-activity',
      sequence: 0,
      activityType: 'goldenActivity',
      activityId: 'activity-0',
      taskQueue: 'golden-task-queue',
      input: [{ value: 'activity-input' }],
      timeouts: {
        scheduleToCloseTimeoutMs: 10_000,
        scheduleToStartTimeoutMs: 1_000,
        startToCloseTimeoutMs: 5_000,
        heartbeatTimeoutMs: 2_000,
      },
      retry: {
        initialIntervalMs: 100,
        maximumIntervalMs: 1_000,
        backoffCoefficient: 2,
        maximumAttempts: 3,
        nonRetryableErrorTypes: ['FatalActivityError'],
      },
    },
    {
      id: 'start-timer-1',
      kind: 'start-timer',
      sequence: 1,
      timerId: 'timer-1',
      timeoutMs: 250,
    },
    {
      id: 'start-child-workflow-2',
      kind: 'start-child-workflow',
      sequence: 2,
      workflowType: 'childWorkflow',
      workflowId: 'child-workflow-id',
      namespace: 'default',
      taskQueue: 'golden-task-queue',
      input: ['child-input'],
      timeouts: {
        workflowExecutionTimeoutMs: 20_000,
        workflowRunTimeoutMs: 15_000,
        workflowTaskTimeoutMs: 5_000,
      },
    },
    {
      id: 'record-marker-3',
      kind: 'record-marker',
      sequence: 3,
      markerName: 'golden-marker',
      details: { value: 42 },
    },
    {
      id: 'upsert-search-attributes-4',
      kind: 'upsert-search-attributes',
      sequence: 4,
      searchAttributes: { SearchKeywordField: 'golden' },
    },
  ]

  const commands = await materializeCommands(intents, { dataConverter, workflowInfo })
  const projection = commands.map((command) => ({
    commandType: CommandType[command.commandType],
    attributes: command.attributes.case,
  }))

  expect(projection).toEqual([
    {
      commandType: 'SCHEDULE_ACTIVITY_TASK',
      attributes: 'scheduleActivityTaskCommandAttributes',
    },
    {
      commandType: 'START_TIMER',
      attributes: 'startTimerCommandAttributes',
    },
    {
      commandType: 'START_CHILD_WORKFLOW_EXECUTION',
      attributes: 'startChildWorkflowExecutionCommandAttributes',
    },
    {
      commandType: 'RECORD_MARKER',
      attributes: 'recordMarkerCommandAttributes',
    },
    {
      commandType: 'UPSERT_WORKFLOW_SEARCH_ATTRIBUTES',
      attributes: 'upsertWorkflowSearchAttributesCommandAttributes',
    },
  ])

  const activity = commands[0]
  expect(activity.attributes.case).toBe('scheduleActivityTaskCommandAttributes')
  if (activity.attributes.case === 'scheduleActivityTaskCommandAttributes') {
    expect(activity.attributes.value.activityId).toBe('activity-0')
    expect(activity.attributes.value.activityType?.name).toBe('goldenActivity')
    expect(activity.attributes.value.taskQueue?.name).toBe('golden-task-queue')
    expect(activity.attributes.value.retryPolicy?.maximumAttempts).toBe(3)
  }

  const marker = commands[3]
  expect(marker.attributes.case).toBe('recordMarkerCommandAttributes')
  if (marker.attributes.case === 'recordMarkerCommandAttributes') {
    expect(marker.attributes.value.markerName).toBe('golden-marker')
    expect(Object.keys(marker.attributes.value.details)).toEqual(['value'])
  }
})
