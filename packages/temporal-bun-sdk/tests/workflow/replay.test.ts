import { create } from '@bufbuild/protobuf'
import { expect, test } from 'bun:test'
import { Effect } from 'effect'

import { createDefaultDataConverter, encodeValuesToPayloads } from '../../src/common/payloads'
import type { WorkflowInfo } from '../../src/workflow/context'
import type { WorkflowDeterminismState } from '../../src/workflow/determinism'
import {
  decodeDeterminismMarkerEnvelope,
  diffDeterminismState,
  encodeDeterminismMarkerDetails,
  ingestWorkflowHistory,
  resolveHistoryLastEventId,
} from '../../src/workflow/replay'
import {
  ActivityTaskScheduledEventAttributesSchema,
  HistoryEventSchema,
  MarkerRecordedEventAttributesSchema,
  SignalExternalWorkflowExecutionInitiatedEventAttributesSchema,
  StartChildWorkflowExecutionInitiatedEventAttributesSchema,
  TimerStartedEventAttributesSchema,
  WorkflowExecutionContinuedAsNewEventAttributesSchema,
} from '../../src/proto/temporal/api/history/v1/message_pb'
import { EventType } from '../../src/proto/temporal/api/enums/v1/event_type_pb'
import { TaskQueueSchema } from '../../src/proto/temporal/api/taskqueue/v1/message_pb'
import { PayloadsSchema, WorkflowExecutionSchema } from '../../src/proto/temporal/api/common/v1/message_pb'
import type { WorkflowCommandIntent } from '../../src/workflow/commands'

test('encodes and decodes determinism marker envelopes', async () => {
  const converter = createDefaultDataConverter()
  const info: WorkflowInfo = {
    namespace: 'default',
    taskQueue: 'prix',
    workflowId: 'wf-123',
    runId: 'run-abc',
    workflowType: 'testWorkflow',
  }
  const determinismState: WorkflowDeterminismState = {
    commandHistory: [
      {
        intent: {
          kind: 'start-timer',
          id: 'command-0',
          sequence: 0,
          timerId: 'timer-0',
          timeoutMs: 1000,
        },
      },
    ],
    randomValues: [0.42],
    timeValues: [1728000000],
  }

  const details = await Effect.runPromise(
    encodeDeterminismMarkerDetails(converter, {
      info,
      determinismState,
      lastEventId: '42',
      recordedAt: new Date('2025-01-01T00:00:00Z'),
    }),
  )

  const decoded = await Effect.runPromise(
    decodeDeterminismMarkerEnvelope({
      converter,
      details,
    }),
  )

  expect(decoded).toBeDefined()
  expect(decoded?.workflow).toEqual(info)
  expect(decoded?.determinismState).toEqual(determinismState)
  expect(decoded?.lastEventId).toBe('42')
  expect(decoded?.recordedAtIso).toBe('2025-01-01T00:00:00.000Z')
})

test('ingestWorkflowHistory returns determinism marker snapshot when available', async () => {
  const converter = createDefaultDataConverter()
  const info: WorkflowInfo = {
    namespace: 'default',
    taskQueue: 'prix',
    workflowId: 'wf-321',
    runId: 'run-marker',
    workflowType: 'exampleWorkflow',
  }
  const determinismState: WorkflowDeterminismState = {
    commandHistory: [
      {
        intent: {
          kind: 'schedule-activity',
          id: 'schedule-activity-0',
          sequence: 0,
          activityType: 'sendEmail',
          activityId: 'send-0',
          taskQueue: 'prix',
          input: ['hello@acme.test'],
          timeouts: {},
          retry: undefined,
          requestEagerExecution: undefined,
        },
      },
    ],
    randomValues: [0.99],
    timeValues: [1730000000000],
  }

  const details = await Effect.runPromise(
    encodeDeterminismMarkerDetails(converter, {
      info,
      determinismState,
      lastEventId: '20',
      recordedAt: new Date('2025-01-01T00:00:00Z'),
    }),
  )

  const markerEvent = create(HistoryEventSchema, {
    eventId: 20n,
    eventType: EventType.MARKER_RECORDED,
    attributes: {
      case: 'markerRecordedEventAttributes',
      value: create(MarkerRecordedEventAttributesSchema, {
        markerName: 'temporal-bun-sdk/determinism',
        details,
        workflowTaskCompletedEventId: 19n,
      }),
    },
  })

  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info,
      history: [markerEvent],
      dataConverter: converter,
    }),
  )

  expect(replay.lastEventId).toBe('20')
  expect(replay.determinismState).toEqual(determinismState)
  expect(replay.hasDeterminismMarker).toBe(true)
})

test('ingestWorkflowHistory reconstructs command history from legacy events when marker missing', async () => {
  const converter = createDefaultDataConverter()
  const info: WorkflowInfo = {
    namespace: 'default',
    taskQueue: 'prix',
    workflowId: 'wf-legacy',
    runId: 'run-legacy',
    workflowType: 'legacyWorkflow',
  }

  const activityPayloads =
    (await encodeValuesToPayloads(converter, ['payload'])) ?? []
  const activityEvent = create(HistoryEventSchema, {
    eventId: 1n,
    eventType: EventType.ACTIVITY_TASK_SCHEDULED,
    attributes: {
      case: 'activityTaskScheduledEventAttributes',
      value: create(ActivityTaskScheduledEventAttributesSchema, {
        activityId: 'activity-42',
        activityType: { name: 'sendEmail' },
        taskQueue: create(TaskQueueSchema, { name: 'worker-q' }),
        input: create(PayloadsSchema, { payloads: activityPayloads }),
        scheduleToCloseTimeout: { seconds: 5n, nanos: 0 },
        scheduleToStartTimeout: { seconds: 1n, nanos: 0 },
        startToCloseTimeout: { seconds: 4n, nanos: 0 },
        heartbeatTimeout: { seconds: 2n, nanos: 0 },
        workflowTaskCompletedEventId: 0n,
      }),
    },
  })

  const timerEvent = create(HistoryEventSchema, {
    eventId: 2n,
    eventType: EventType.TIMER_STARTED,
    attributes: {
      case: 'timerStartedEventAttributes',
      value: create(TimerStartedEventAttributesSchema, {
        timerId: 'timeout-timer',
        startToFireTimeout: { seconds: 3n, nanos: 0 },
        workflowTaskCompletedEventId: 1n,
      }),
    },
  })

  const signalPayloads =
    (await encodeValuesToPayloads(converter, ['ping'])) ?? []
  const signalEvent = create(HistoryEventSchema, {
    eventId: 3n,
    eventType: EventType.SIGNAL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED,
    attributes: {
      case: 'signalExternalWorkflowExecutionInitiatedEventAttributes',
      value: create(SignalExternalWorkflowExecutionInitiatedEventAttributesSchema, {
        workflowTaskCompletedEventId: 2n,
        namespace: 'default',
        workflowExecution: create(WorkflowExecutionSchema, {
          workflowId: 'target-wf',
          runId: 'target-run',
        }),
        signalName: 'notify',
        input: create(PayloadsSchema, { payloads: signalPayloads }),
        childWorkflowOnly: false,
      }),
    },
  })

  const childPayloads =
    (await encodeValuesToPayloads(converter, ['child-input'])) ?? []
  const startChildEvent = create(HistoryEventSchema, {
    eventId: 4n,
    eventType: EventType.START_CHILD_WORKFLOW_EXECUTION_INITIATED,
    attributes: {
      case: 'startChildWorkflowExecutionInitiatedEventAttributes',
      value: create(StartChildWorkflowExecutionInitiatedEventAttributesSchema, {
        namespace: 'child-space',
        workflowId: 'child-wf',
        workflowType: { name: 'childWorkflow' },
        taskQueue: create(TaskQueueSchema, { name: 'child-q' }),
        input: create(PayloadsSchema, { payloads: childPayloads }),
        workflowExecutionTimeout: { seconds: 20n, nanos: 0 },
        workflowRunTimeout: { seconds: 10n, nanos: 0 },
        workflowTaskTimeout: { seconds: 5n, nanos: 0 },
        parentClosePolicy: 1,
        workflowIdReusePolicy: 2,
        workflowTaskCompletedEventId: 3n,
        cronSchedule: '0 * * * *',
      }),
    },
  })

  const continuePayloads =
    (await encodeValuesToPayloads(converter, [['state']])) ?? []
  const continueEvent = create(HistoryEventSchema, {
    eventId: 5n,
    eventType: EventType.WORKFLOW_EXECUTION_CONTINUED_AS_NEW,
    attributes: {
      case: 'workflowExecutionContinuedAsNewEventAttributes',
      value: create(WorkflowExecutionContinuedAsNewEventAttributesSchema, {
        newExecutionRunId: 'run-new',
        workflowType: { name: 'legacyWorkflow' },
        taskQueue: create(TaskQueueSchema, { name: 'prix' }),
        input: create(PayloadsSchema, { payloads: continuePayloads }),
        workflowRunTimeout: { seconds: 30n, nanos: 0 },
        workflowTaskTimeout: { seconds: 5n, nanos: 0 },
        workflowTaskCompletedEventId: 4n,
        backoffStartInterval: { seconds: 1n, nanos: 0 },
      }),
    },
  })

  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info,
      history: [activityEvent, timerEvent, signalEvent, startChildEvent, continueEvent],
      dataConverter: converter,
    }),
  )

  expect(replay.lastEventId).toBe('5')
  expect(replay.hasDeterminismMarker).toBe(false)
  expect(replay.determinismState.commandHistory).toHaveLength(5)

  const [activity, timer, signal, child, cont] = replay.determinismState.commandHistory.map((entry) => entry.intent)

  expect(activity.kind).toBe('schedule-activity')
  if (activity.kind === 'schedule-activity') {
    expect(activity.activityType).toBe('sendEmail')
    expect(activity.taskQueue).toBe('worker-q')
    expect(activity.input).toEqual(['payload'])
  }

  expect(timer.kind).toBe('start-timer')
  if (timer.kind === 'start-timer') {
    expect(timer.timerId).toBe('timeout-timer')
    expect(timer.timeoutMs).toBe(3000)
  }

  expect(signal.kind).toBe('signal-external-workflow')
  if (signal.kind === 'signal-external-workflow') {
    expect(signal.namespace).toBe('default')
    expect(signal.workflowId).toBe('target-wf')
    expect(signal.input).toEqual(['ping'])
  }

  expect(child.kind).toBe('start-child-workflow')
  if (child.kind === 'start-child-workflow') {
    expect(child.workflowType).toBe('childWorkflow')
    expect(child.taskQueue).toBe('child-q')
    expect(child.input).toEqual(['child-input'])
    expect(child.parentClosePolicy).toBe(1)
    expect(child.workflowIdReusePolicy).toBe(2)
  }

  expect(cont.kind).toBe('continue-as-new')
  if (cont.kind === 'continue-as-new') {
    expect(cont.workflowType).toBe('legacyWorkflow')
    expect(cont.input).toEqual([['state']])
    expect(cont.backoffStartIntervalMs).toBe(1000)
  }
})

test('diffDeterminismState surfaces mismatched intents and scalar values', async () => {
  const expected: WorkflowDeterminismState = {
    commandHistory: [
      {
        intent: {
          id: 'start-timer-0',
          kind: 'start-timer',
          sequence: 0,
          timerId: 'timer-0',
          timeoutMs: 1000,
        },
      },
      {
        intent: {
          id: 'schedule-activity-1',
          kind: 'schedule-activity',
          sequence: 1,
          activityType: 'process',
          activityId: 'activity-1',
          taskQueue: 'primary',
          input: [],
          timeouts: {},
          retry: undefined,
          requestEagerExecution: undefined,
        },
      },
    ],
    randomValues: [0.1],
    timeValues: [1000],
  }

  const actual: WorkflowDeterminismState = {
    commandHistory: [
      expected.commandHistory[0],
      {
        intent: {
          id: 'schedule-activity-1',
          kind: 'schedule-activity',
          sequence: 1,
          activityType: 'process',
          activityId: 'activity-2',
          taskQueue: 'primary',
          input: [],
          timeouts: {},
          retry: undefined,
          requestEagerExecution: undefined,
        },
      },
      {
        intent: {
          id: 'signal-external-2',
          kind: 'signal-external-workflow',
          sequence: 2,
          namespace: 'default',
          workflowId: 'wf-legacy',
          signalName: 'ping',
          input: [],
          childWorkflowOnly: false,
        },
      },
    ],
    randomValues: [0.2],
    timeValues: [],
  }

  const diff = await Effect.runPromise(diffDeterminismState(expected, actual))

  expect(diff.mismatches).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'command', index: 1 }),
      expect.objectContaining({ kind: 'command', index: 2 }),
      expect.objectContaining({ kind: 'random', index: 0 }),
      expect.objectContaining({ kind: 'time', index: 0 }),
    ]),
  )
})

test('resolveHistoryLastEventId normalizes bigint identifiers', () => {
  const event = create(HistoryEventSchema, { eventId: 123n })
  expect(resolveHistoryLastEventId([event])).toBe('123')
  expect(resolveHistoryLastEventId([])).toBeNull()
})
