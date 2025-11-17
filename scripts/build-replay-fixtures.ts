#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { create } from '@bufbuild/protobuf'
import { PayloadsSchema } from '../packages/temporal-bun-sdk/src/proto/temporal/api/common/v1/message_pb'
import { EventType } from '../packages/temporal-bun-sdk/src/proto/temporal/api/enums/v1/event_type_pb'
import type { HistoryEvent } from '../packages/temporal-bun-sdk/src/proto/temporal/api/history/v1/message_pb'
import {
  ActivityTaskScheduledEventAttributesSchema,
  HistoryEventSchema,
  StartChildWorkflowExecutionInitiatedEventAttributesSchema,
  TimerStartedEventAttributesSchema,
  WorkflowExecutionContinuedAsNewEventAttributesSchema,
} from '../packages/temporal-bun-sdk/src/proto/temporal/api/history/v1/message_pb'
import { TaskQueueSchema } from '../packages/temporal-bun-sdk/src/proto/temporal/api/taskqueue/v1/message_pb'

type Fixture = {
  name: string
  info: {
    workflowType: string
    namespace: string
    taskQueue: string
    workflowId: string
    runId: string
    temporalVersion: string
  }
  history: HistoryEvent[]
  expected: {
    commandHistory: unknown[]
    randomValues: number[]
    timeValues: number[]
  }
}

const fixtures: Fixture[] = [
  {
    name: 'timer-workflow',
    info: {
      workflowType: 'timerWorkflow',
      namespace: 'default',
      taskQueue: 'prix',
      workflowId: 'fixture-timer',
      runId: 'fixture-timer-run',
      temporalVersion: 'dev-fixture',
    },
    history: [
      create(HistoryEventSchema, {
        eventId: 1n,
        eventType: EventType.TIMER_STARTED,
        attributes: {
          case: 'timerStartedEventAttributes',
          value: create(TimerStartedEventAttributesSchema, {
            timerId: 'fixture-timer-0',
            startToFireTimeout: { seconds: 1n, nanos: 0 },
            workflowTaskCompletedEventId: 0n,
          }),
        },
      }),
    ],
    expected: {
      commandHistory: [
        {
          intent: {
            id: 'start-timer-0',
            kind: 'start-timer',
            sequence: 0,
            timerId: 'fixture-timer-0',
            timeoutMs: 1000,
          },
          metadata: {
            eventId: '1',
            eventType: EventType.TIMER_STARTED,
            workflowTaskCompletedEventId: '0',
          },
        },
      ],
      randomValues: [],
      timeValues: [],
    },
  },
  {
    name: 'activity-retry-workflow',
    info: {
      workflowType: 'activityWorkflow',
      namespace: 'default',
      taskQueue: 'prix',
      workflowId: 'fixture-activity',
      runId: 'fixture-activity-run',
      temporalVersion: 'dev-fixture',
    },
    history: [
      create(HistoryEventSchema, {
        eventId: 10n,
        eventType: EventType.ACTIVITY_TASK_SCHEDULED,
        attributes: {
          case: 'activityTaskScheduledEventAttributes',
          value: create(ActivityTaskScheduledEventAttributesSchema, {
            activityId: 'fixture-activity-1',
            activityType: { name: 'recordMetric' },
            taskQueue: create(TaskQueueSchema, { name: 'prix' }),
            input: create(PayloadsSchema, { payloads: [] }),
            retryPolicy: {
              initialInterval: { seconds: 1n, nanos: 0 },
              maximumAttempts: 3,
              backoffCoefficient: 2,
            },
            workflowTaskCompletedEventId: 9n,
          }),
        },
      }),
    ],
    expected: {
      commandHistory: [
        {
          intent: {
            id: 'schedule-activity-0',
            kind: 'schedule-activity',
            sequence: 0,
            activityType: 'recordMetric',
            activityId: 'fixture-activity-1',
            taskQueue: 'prix',
            input: [],
            timeouts: {},
            retry: {
              initialIntervalMs: 1000,
              maximumAttempts: 3,
              backoffCoefficient: 2,
            },
          },
          metadata: {
            eventId: '10',
            eventType: EventType.ACTIVITY_TASK_SCHEDULED,
            workflowTaskCompletedEventId: '9',
          },
        },
      ],
      randomValues: [],
      timeValues: [],
    },
  },
  {
    name: 'child-continue-workflow',
    info: {
      workflowType: 'parentWorkflow',
      namespace: 'default',
      taskQueue: 'prix',
      workflowId: 'fixture-parent',
      runId: 'fixture-parent-run',
      temporalVersion: 'dev-fixture',
    },
    history: [
      create(HistoryEventSchema, {
        eventId: 21n,
        eventType: EventType.START_CHILD_WORKFLOW_EXECUTION_INITIATED,
        attributes: {
          case: 'startChildWorkflowExecutionInitiatedEventAttributes',
          value: create(StartChildWorkflowExecutionInitiatedEventAttributesSchema, {
            workflowId: 'fixture-child',
            workflowType: { name: 'childWorkflow' },
            taskQueue: create(TaskQueueSchema, { name: 'prix-child' }),
            workflowExecutionTimeout: { seconds: 20n, nanos: 0 },
            workflowRunTimeout: { seconds: 10n, nanos: 0 },
            workflowTaskTimeout: { seconds: 5n, nanos: 0 },
            parentClosePolicy: 1,
            workflowTaskCompletedEventId: 20n,
          }),
        },
      }),
      create(HistoryEventSchema, {
        eventId: 22n,
        eventType: EventType.WORKFLOW_EXECUTION_CONTINUED_AS_NEW,
        attributes: {
          case: 'workflowExecutionContinuedAsNewEventAttributes',
          value: create(WorkflowExecutionContinuedAsNewEventAttributesSchema, {
            newExecutionRunId: 'fixture-parent-run-2',
            workflowType: { name: 'parentWorkflow' },
            taskQueue: create(TaskQueueSchema, { name: 'prix' }),
            workflowRunTimeout: { seconds: 30n, nanos: 0 },
            workflowTaskTimeout: { seconds: 10n, nanos: 0 },
            workflowTaskCompletedEventId: 21n,
          }),
        },
      }),
    ],
    expected: {
      commandHistory: [
        {
          intent: {
            id: 'start-child-workflow-0',
            kind: 'start-child-workflow',
            sequence: 0,
            workflowType: 'childWorkflow',
            workflowId: 'fixture-child',
            namespace: 'default',
            taskQueue: 'prix-child',
            input: [],
            timeouts: {
              workflowExecutionTimeoutMs: 20000,
              workflowRunTimeoutMs: 10000,
              workflowTaskTimeoutMs: 5000,
            },
            parentClosePolicy: 1,
          },
          metadata: {
            eventId: '21',
            eventType: EventType.START_CHILD_WORKFLOW_EXECUTION_INITIATED,
            workflowTaskCompletedEventId: '20',
          },
        },
        {
          intent: {
            id: 'continue-as-new-1',
            kind: 'continue-as-new',
            sequence: 1,
            workflowType: 'parentWorkflow',
            taskQueue: 'prix',
            input: [],
            timeouts: {
              workflowRunTimeoutMs: 30000,
              workflowTaskTimeoutMs: 10000,
            },
          },
          metadata: {
            eventId: '22',
            eventType: EventType.WORKFLOW_EXECUTION_CONTINUED_AS_NEW,
            workflowTaskCompletedEventId: '21',
          },
        },
      ],
      randomValues: [],
      timeValues: [],
    },
  },
]

const targetDir = join(import.meta.dir, '..', 'packages', 'temporal-bun-sdk', 'tests', 'replay', 'fixtures')
const replacer = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)
const sanitizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry))
  }
  if (value instanceof Uint8Array) {
    return Array.from(value)
  }
  if (value && typeof value === 'object') {
    const typed = value as { $typeName?: string; seconds?: unknown; nanos?: unknown }
    if (typed.$typeName === 'google.protobuf.Duration') {
      const seconds = typeof typed.seconds === 'bigint' ? typed.seconds.toString() : String(typed.seconds ?? '0')
      const nanos = typeof typed.nanos === 'number' ? typed.nanos : Number(typed.nanos ?? 0)
      if (nanos > 0) {
        const fractional = (nanos / 1_000_000_000).toString().slice(1)
        return `${seconds}${fractional}s`
      }
      return `${seconds}s`
    }
    const next: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$typeName') {
        continue
      }
      next[key] = sanitizeValue(entry)
    }
    return next
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  return value
}

const serializeHistoryEvent = (event: HistoryEvent): Record<string, unknown> => {
  const eventTypeName = EventType[event.eventType]
  const base: Record<string, unknown> = {
    eventId: event.eventId.toString(),
    eventType: `EVENT_TYPE_${eventTypeName}`,
    version: event.version?.toString() ?? '0',
    taskId: event.taskId?.toString() ?? '0',
    workerMayIgnore: event.workerMayIgnore ?? false,
  }

  switch (event.attributes?.case) {
    case 'timerStartedEventAttributes':
      base.timerStartedEventAttributes = sanitizeValue(event.attributes.value)
      break
    case 'activityTaskScheduledEventAttributes':
      base.activityTaskScheduledEventAttributes = sanitizeValue(event.attributes.value)
      break
    case 'startChildWorkflowExecutionInitiatedEventAttributes':
      base.startChildWorkflowExecutionInitiatedEventAttributes = sanitizeValue(event.attributes.value)
      break
    case 'workflowExecutionContinuedAsNewEventAttributes':
      base.workflowExecutionContinuedAsNewEventAttributes = sanitizeValue(event.attributes.value)
      break
    default:
      throw new Error(`Unsupported history attribute case: ${String(event.attributes?.case)}`)
  }

  return base
}

await mkdir(targetDir, { recursive: true })

await Promise.all(
  fixtures.map(async (fixture) => {
    const payload = {
      name: fixture.name,
      info: fixture.info,
      history: fixture.history.map((event) => serializeHistoryEvent(event)),
      expectedDeterminismState: fixture.expected,
    }
    const filePath = join(targetDir, `${fixture.name}.json`)
    await writeFile(filePath, `${JSON.stringify(payload, replacer, 2)}\n`, 'utf8')
  }),
)

console.info(`Replay fixtures written to ${targetDir}`)
