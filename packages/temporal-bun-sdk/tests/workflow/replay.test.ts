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
  encodeDeterminismMarkerDetailsWithSize,
  ingestWorkflowHistory,
  resolveHistoryLastEventId,
} from '../../src/workflow/replay'
import type { DeterminismMismatchCommand, DeterminismStateDelta } from '../../src/workflow/replay'
import {
  ActivityTaskScheduledEventAttributesSchema,
  ActivityTaskCancelRequestedEventAttributesSchema,
  HistoryEventSchema,
  MarkerRecordedEventAttributesSchema,
  SignalExternalWorkflowExecutionInitiatedEventAttributesSchema,
  StartChildWorkflowExecutionInitiatedEventAttributesSchema,
  TimerStartedEventAttributesSchema,
  UpsertWorkflowSearchAttributesEventAttributesSchema,
  WorkflowExecutionContinuedAsNewEventAttributesSchema,
  WorkflowExecutionFailedEventAttributesSchema,
} from '../../src/proto/temporal/api/history/v1/message_pb'
import { EventType } from '../../src/proto/temporal/api/enums/v1/event_type_pb'
import { TaskQueueSchema } from '../../src/proto/temporal/api/taskqueue/v1/message_pb'
import {
  ActivityTypeSchema,
  PayloadSchema,
  PayloadsSchema,
  WorkflowExecutionSchema,
} from '../../src/proto/temporal/api/common/v1/message_pb'
import { FailureSchema } from '../../src/proto/temporal/api/failure/v1/message_pb'
import type { WorkflowCommandIntent } from '../../src/workflow/commands'

test('encodes and decodes determinism marker envelopes', async () => {
  const converter = createDefaultDataConverter()
  const info: WorkflowInfo = {
    namespace: 'default',
    taskQueue: 'replay-fixtures',
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
    signals: [],
    queries: [],
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

test('determinism marker size accounting grows with payload size', async () => {
  const converter = createDefaultDataConverter()
  const info: WorkflowInfo = {
    namespace: 'default',
    taskQueue: 'replay-fixtures',
    workflowId: 'wf-size',
    runId: 'run-size',
    workflowType: 'sizeWorkflow',
  }
  const smallState: WorkflowDeterminismState = {
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
    randomValues: [],
    timeValues: [],
    signals: [],
    queries: [],
  }
  const largePayload = 'x'.repeat(10_000)
  const largeState: WorkflowDeterminismState = {
    commandHistory: [
      {
        intent: {
          kind: 'start-timer',
          id: 'command-1',
          sequence: 0,
          timerId: largePayload,
          timeoutMs: 1000,
        },
      },
    ],
    randomValues: [],
    timeValues: [],
    signals: [],
    queries: [],
  }

  const small = await Effect.runPromise(
    encodeDeterminismMarkerDetailsWithSize(converter, {
      info,
      determinismState: smallState,
      lastEventId: '1',
      recordedAt: new Date('2025-01-01T00:00:00Z'),
    }),
  )
  const large = await Effect.runPromise(
    encodeDeterminismMarkerDetailsWithSize(converter, {
      info,
      determinismState: largeState,
      lastEventId: '2',
      recordedAt: new Date('2025-01-01T00:00:00Z'),
    }),
  )

  expect(large.sizeBytes).toBeGreaterThan(small.sizeBytes)
  expect(large.sizeBytes).toBeGreaterThan(1000)
})

test('encodes and decodes determinism delta marker envelopes', async () => {
  const converter = createDefaultDataConverter()
  const info: WorkflowInfo = {
    namespace: 'default',
    taskQueue: 'replay-fixtures',
    workflowId: 'wf-delta',
    runId: 'run-delta',
    workflowType: 'deltaWorkflow',
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
    randomValues: [0.1],
    timeValues: [1728000000],
    signals: [],
    queries: [],
  }
  const determinismDelta: DeterminismStateDelta = {
    commandHistory: [
      {
        intent: {
          kind: 'start-timer',
          id: 'command-1',
          sequence: 1,
          timerId: 'timer-1',
          timeoutMs: 500,
        },
      },
    ],
    randomValues: [0.2],
    timeValues: [],
    signals: [],
    queries: [],
  }

  const details = await Effect.runPromise(
    encodeDeterminismMarkerDetails(converter, {
      info,
      determinismState,
      determinismDelta,
      markerType: 'delta',
      lastEventId: '99',
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
  expect(decoded?.schemaVersion).toBe(2)
  expect(decoded?.workflow).toEqual(info)
  expect(decoded?.determinismDelta).toEqual(determinismDelta)
  expect(decoded?.lastEventId).toBe('99')
})

test('ingestWorkflowHistory returns determinism marker snapshot when available', async () => {
  const converter = createDefaultDataConverter()
  const info: WorkflowInfo = {
    namespace: 'default',
    taskQueue: 'replay-fixtures',
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
          taskQueue: 'replay-fixtures',
          input: ['hello@acme.test'],
          timeouts: {},
          retry: undefined,
          requestEagerExecution: undefined,
        },
      },
    ],
    randomValues: [0.99],
    timeValues: [1730000000000],
    signals: [],
    queries: [],
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

  const activityEvent = create(HistoryEventSchema, {
    eventId: 1n,
    eventType: EventType.ACTIVITY_TASK_SCHEDULED,
    attributes: {
      case: 'activityTaskScheduledEventAttributes',
      value: create(ActivityTaskScheduledEventAttributesSchema, {
        activityId: 'send-0',
        activityType: create(ActivityTypeSchema, { name: 'sendEmail' }),
        taskQueue: create(TaskQueueSchema, { name: 'replay-fixtures' }),
        scheduleToCloseTimeout: { seconds: 30n, nanos: 0 },
        startToCloseTimeout: { seconds: 5n, nanos: 0 },
        workflowTaskCompletedEventId: 1n,
      }),
    },
  })

  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info,
      history: [activityEvent, markerEvent],
      dataConverter: converter,
    }),
  )

  expect(replay.lastEventId).toBe('20')
  expect(replay.determinismState).toEqual(determinismState)
  expect(replay.hasDeterminismMarker).toBe(true)
})

test('ingestWorkflowHistory applies determinism delta markers', async () => {
  const converter = createDefaultDataConverter()
  const info: WorkflowInfo = {
    namespace: 'default',
    taskQueue: 'replay-fixtures',
    workflowId: 'wf-delta-history',
    runId: 'run-delta-history',
    workflowType: 'deltaWorkflow',
  }
  const determinismState: WorkflowDeterminismState = {
    commandHistory: [
      {
        intent: {
          kind: 'start-timer',
          id: 'timer-0',
          sequence: 0,
          timerId: 'timer-0',
          timeoutMs: 500,
        },
      },
    ],
    randomValues: [0.1],
    timeValues: [],
    signals: [],
    queries: [],
  }
  const determinismDelta: DeterminismStateDelta = {
    commandHistory: [
      {
        intent: {
          kind: 'start-timer',
          id: 'timer-1',
          sequence: 1,
          timerId: 'timer-1',
          timeoutMs: 1000,
        },
      },
    ],
    randomValues: [0.2],
    timeValues: [],
    signals: [],
    queries: [],
  }

  const fullDetails = await Effect.runPromise(
    encodeDeterminismMarkerDetails(converter, {
      info,
      determinismState,
      lastEventId: '10',
      recordedAt: new Date('2025-01-01T00:00:00Z'),
    }),
  )
  const deltaDetails = await Effect.runPromise(
    encodeDeterminismMarkerDetails(converter, {
      info,
      determinismState,
      determinismDelta,
      markerType: 'delta',
      lastEventId: '11',
      recordedAt: new Date('2025-01-01T00:00:01Z'),
    }),
  )

  const markerEvent = create(HistoryEventSchema, {
    eventId: 10n,
    eventType: EventType.MARKER_RECORDED,
    attributes: {
      case: 'markerRecordedEventAttributes',
      value: create(MarkerRecordedEventAttributesSchema, {
        markerName: 'temporal-bun-sdk/determinism',
        details: fullDetails,
      }),
    },
  })
  const deltaMarkerEvent = create(HistoryEventSchema, {
    eventId: 11n,
    eventType: EventType.MARKER_RECORDED,
    attributes: {
      case: 'markerRecordedEventAttributes',
      value: create(MarkerRecordedEventAttributesSchema, {
        markerName: 'temporal-bun-sdk/determinism',
        details: deltaDetails,
      }),
    },
  })

  const timerEvent = create(HistoryEventSchema, {
    eventId: 1n,
    eventType: EventType.TIMER_STARTED,
    attributes: {
      case: 'timerStartedEventAttributes',
      value: create(TimerStartedEventAttributesSchema, {
        timerId: 'timer-0',
        startToFireTimeout: { seconds: 0n, nanos: 500_000_000 },
        workflowTaskCompletedEventId: 1n,
      }),
    },
  })

  const timerDeltaEvent = create(HistoryEventSchema, {
    eventId: 2n,
    eventType: EventType.TIMER_STARTED,
    attributes: {
      case: 'timerStartedEventAttributes',
      value: create(TimerStartedEventAttributesSchema, {
        timerId: 'timer-1',
        startToFireTimeout: { seconds: 1n, nanos: 0 },
        workflowTaskCompletedEventId: 2n,
      }),
    },
  })

  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info,
      history: [timerEvent, timerDeltaEvent, markerEvent, deltaMarkerEvent],
      dataConverter: converter,
    }),
  )

  expect(replay.hasDeterminismMarker).toBe(true)
  expect(replay.determinismState.commandHistory).toHaveLength(2)
  expect(replay.determinismState.randomValues).toEqual([0.1, 0.2])
})

test('ingestWorkflowHistory applies determinism markers and replays trailing history', async () => {
  const converter = createDefaultDataConverter()
  const info: WorkflowInfo = {
    namespace: 'default',
    taskQueue: 'replay-fixtures',
    workflowId: 'wf-marker-gap',
    runId: 'run-marker-gap',
    workflowType: 'markerGapWorkflow',
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
          taskQueue: 'replay-fixtures',
          input: ['hello@acme.test'],
          timeouts: {},
          retry: undefined,
          requestEagerExecution: undefined,
        },
      },
    ],
    randomValues: [],
    timeValues: [],
    signals: [],
    queries: [],
  }

  const details = await Effect.runPromise(
    encodeDeterminismMarkerDetails(converter, {
      info,
      determinismState,
      lastEventId: '10',
      recordedAt: new Date('2025-01-01T00:00:00Z'),
    }),
  )

  const activityEvent = create(HistoryEventSchema, {
    eventId: 1n,
    eventType: EventType.ACTIVITY_TASK_SCHEDULED,
    attributes: {
      case: 'activityTaskScheduledEventAttributes',
      value: create(ActivityTaskScheduledEventAttributesSchema, {
        activityId: 'send-0',
        activityType: create(ActivityTypeSchema, { name: 'sendEmail' }),
        taskQueue: create(TaskQueueSchema, { name: 'replay-fixtures' }),
        scheduleToCloseTimeout: { seconds: 30n, nanos: 0 },
        startToCloseTimeout: { seconds: 5n, nanos: 0 },
        workflowTaskCompletedEventId: 1n,
      }),
    },
  })

  const markerEvent = create(HistoryEventSchema, {
    eventId: 10n,
    eventType: EventType.MARKER_RECORDED,
    attributes: {
      case: 'markerRecordedEventAttributes',
      value: create(MarkerRecordedEventAttributesSchema, {
        markerName: 'temporal-bun-sdk/determinism',
        details,
      }),
    },
  })

  const timerEvent = create(HistoryEventSchema, {
    eventId: 11n,
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

  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info,
      history: [activityEvent, markerEvent, timerEvent],
      dataConverter: converter,
    }),
  )

  expect(replay.determinismState.commandHistory).toHaveLength(2)
  expect(replay.determinismState.commandHistory[0]?.intent.kind).toBe('schedule-activity')
  expect(replay.determinismState.commandHistory[1]?.intent.kind).toBe('start-timer')
})

test('ingestWorkflowHistory replays cancel intents after marker using pre-marker schedules', async () => {
  const converter = createDefaultDataConverter()
  const info: WorkflowInfo = {
    namespace: 'default',
    taskQueue: 'replay-fixtures',
    workflowId: 'wf-marker-cancel',
    runId: 'run-marker-cancel',
    workflowType: 'markerCancelWorkflow',
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
          taskQueue: 'replay-fixtures',
          input: ['hello@acme.test'],
          timeouts: {},
          retry: undefined,
          requestEagerExecution: undefined,
        },
      },
    ],
    randomValues: [],
    timeValues: [],
    signals: [],
    queries: [],
  }

  const details = await Effect.runPromise(
    encodeDeterminismMarkerDetails(converter, {
      info,
      determinismState,
      lastEventId: '6',
      recordedAt: new Date('2025-01-01T00:00:00Z'),
    }),
  )

  const scheduledPayloads = (await encodeValuesToPayloads(converter, ['hello@acme.test'])) ?? []
  const scheduleEvent = create(HistoryEventSchema, {
    eventId: 5n,
    eventType: EventType.ACTIVITY_TASK_SCHEDULED,
    attributes: {
      case: 'activityTaskScheduledEventAttributes',
      value: create(ActivityTaskScheduledEventAttributesSchema, {
        activityId: 'send-0',
        activityType: { name: 'sendEmail' },
        taskQueue: create(TaskQueueSchema, { name: 'replay-fixtures' }),
        input: create(PayloadsSchema, { payloads: scheduledPayloads }),
        workflowTaskCompletedEventId: 4n,
      }),
    },
  })

  const markerEvent = create(HistoryEventSchema, {
    eventId: 6n,
    eventType: EventType.MARKER_RECORDED,
    attributes: {
      case: 'markerRecordedEventAttributes',
      value: create(MarkerRecordedEventAttributesSchema, {
        markerName: 'temporal-bun-sdk/determinism',
        details,
        workflowTaskCompletedEventId: 5n,
      }),
    },
  })

  const cancelEvent = create(HistoryEventSchema, {
    eventId: 7n,
    eventType: EventType.ACTIVITY_TASK_CANCEL_REQUESTED,
    attributes: {
      case: 'activityTaskCancelRequestedEventAttributes',
      value: create(ActivityTaskCancelRequestedEventAttributesSchema, {
        scheduledEventId: 5n,
        workflowTaskCompletedEventId: 6n,
      }),
    },
  })

  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info,
      history: [scheduleEvent, markerEvent, cancelEvent],
      dataConverter: converter,
    }),
  )

  expect(replay.determinismState.commandHistory).toHaveLength(2)
  expect(replay.determinismState.commandHistory[1]?.intent.kind).toBe('request-cancel-activity')
  expect(
    replay.determinismState.commandHistory[1]?.intent.kind === 'request-cancel-activity'
      ? replay.determinismState.commandHistory[1]?.intent.activityId
      : null,
  ).toBe('send-0')
})

test('ingestWorkflowHistory ignores incomplete marker snapshots', async () => {
  const converter = createDefaultDataConverter()
  const info: WorkflowInfo = {
    namespace: 'default',
    taskQueue: 'replay-fixtures',
    workflowId: 'wf-marker-incomplete',
    runId: 'run-marker-incomplete',
    workflowType: 'markerIncompleteWorkflow',
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
          taskQueue: 'replay-fixtures',
          input: ['hello@acme.test'],
          timeouts: {
            scheduleToCloseTimeoutMs: 30_000,
            startToCloseTimeoutMs: 5_000,
          },
          retry: undefined,
          requestEagerExecution: undefined,
        },
      },
    ],
    randomValues: [],
    timeValues: [],
    signals: [],
    queries: [],
  }

  const markerDetails = await Effect.runPromise(
    encodeDeterminismMarkerDetails(converter, {
      info,
      determinismState,
      lastEventId: '3',
      recordedAt: new Date('2025-01-01T00:00:00Z'),
    }),
  )

  const activityEvent = create(HistoryEventSchema, {
    eventId: 1n,
    eventType: EventType.ACTIVITY_TASK_SCHEDULED,
    attributes: {
      case: 'activityTaskScheduledEventAttributes',
      value: create(ActivityTaskScheduledEventAttributesSchema, {
        activityId: 'send-0',
        activityType: create(ActivityTypeSchema, { name: 'sendEmail' }),
        taskQueue: create(TaskQueueSchema, { name: 'replay-fixtures' }),
        scheduleToCloseTimeout: { seconds: 30n, nanos: 0 },
        startToCloseTimeout: { seconds: 5n, nanos: 0 },
        workflowTaskCompletedEventId: 1n,
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

  const markerEvent = create(HistoryEventSchema, {
    eventId: 3n,
    eventType: EventType.MARKER_RECORDED,
    attributes: {
      case: 'markerRecordedEventAttributes',
      value: create(MarkerRecordedEventAttributesSchema, {
        markerName: 'temporal-bun-sdk/determinism',
        details: markerDetails,
      }),
    },
  })

  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info,
      history: [activityEvent, timerEvent, markerEvent],
      dataConverter: converter,
    }),
  )

  expect(replay.hasDeterminismMarker).toBe(false)
  expect(replay.determinismState.commandHistory).toHaveLength(2)
  expect(replay.determinismState.commandHistory[0]?.intent.kind).toBe('schedule-activity')
  expect(replay.determinismState.commandHistory[1]?.intent.kind).toBe('start-timer')
})

test('ingestWorkflowHistory reconstructs command history from legacy events when marker missing', async () => {
  const converter = createDefaultDataConverter()
  const info: WorkflowInfo = {
    namespace: 'default',
    taskQueue: 'replay-fixtures',
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
        taskQueue: create(TaskQueueSchema, { name: 'replay-fixtures' }),
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
    expect(replay.determinismState.commandHistory[0]?.metadata?.eventId).toBe('1')
    expect(replay.determinismState.commandHistory[0]?.metadata?.workflowTaskCompletedEventId).toBe('0')
  }

  expect(timer.kind).toBe('start-timer')
  if (timer.kind === 'start-timer') {
    expect(timer.timerId).toBe('timeout-timer')
    expect(timer.timeoutMs).toBe(3000)
    expect(replay.determinismState.commandHistory[1]?.metadata?.eventId).toBe('2')
  }

  expect(signal.kind).toBe('signal-external-workflow')
  if (signal.kind === 'signal-external-workflow') {
    expect(signal.namespace).toBe('default')
    expect(signal.workflowId).toBe('target-wf')
    expect(signal.input).toEqual(['ping'])
    expect(replay.determinismState.commandHistory[2]?.metadata?.eventId).toBe('3')
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
    expect(replay.determinismState.commandHistory[4]?.metadata?.eventId).toBe('5')
  }
})

test('ingestWorkflowHistory captures failure metadata from workflow events', async () => {
  const converter = createDefaultDataConverter()
  const info: WorkflowInfo = {
    namespace: 'default',
    taskQueue: 'replay-fixtures',
    workflowId: 'wf-failure',
    runId: 'run-failure',
    workflowType: 'failingWorkflow',
  }

  const failure = create(FailureSchema, {
    message: 'boom',
    source: 'workflow-test',
    failureInfo: {
      case: 'applicationFailureInfo',
      value: {
        type: 'ExampleFailure',
        nonRetryable: false,
      },
    },
  })

  const failureEvent = create(HistoryEventSchema, {
    eventId: 9n,
    eventType: EventType.WORKFLOW_EXECUTION_FAILED,
    attributes: {
      case: 'workflowExecutionFailedEventAttributes',
      value: create(WorkflowExecutionFailedEventAttributesSchema, {
        failure,
        retryState: 3,
        workflowTaskCompletedEventId: 8n,
        newExecutionRunId: 'run-new',
      }),
    },
  })

  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info,
      history: [failureEvent],
      dataConverter: converter,
    }),
  )

  expect(replay.determinismState.failureMetadata).toEqual({
    eventId: '9',
    eventType: EventType.WORKFLOW_EXECUTION_FAILED,
    failureType: 'ExampleFailure',
    failureMessage: 'boom',
    retryState: 3,
  })
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
        metadata: {
          eventId: '10',
          eventType: EventType.TIMER_STARTED,
          workflowTaskCompletedEventId: '9',
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
        metadata: {
          eventId: '11',
          eventType: EventType.ACTIVITY_TASK_SCHEDULED,
          workflowTaskCompletedEventId: '10',
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
        metadata: {
          eventId: '11',
          eventType: EventType.ACTIVITY_TASK_SCHEDULED,
          workflowTaskCompletedEventId: '10',
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
        metadata: {
          eventId: '12',
          eventType: EventType.SIGNAL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED,
          workflowTaskCompletedEventId: '11',
        },
      },
    ],
    randomValues: [0.2],
    timeValues: [],
    signals: [],
    queries: [],
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

  const commandMismatch = diff.mismatches.find(
    (mismatch) => mismatch.kind === 'command' && mismatch.index === 1,
  ) as DeterminismMismatchCommand | undefined
  expect(commandMismatch?.expectedEventId).toBe('11')
  expect(commandMismatch?.workflowTaskCompletedEventId).toBe('10')
})

test('diffDeterminismState ignores acceptedEventId mismatches for workflow updates', async () => {
  const baseState = {
    commandHistory: [],
    randomValues: [],
    timeValues: [],
  }

  const expected: WorkflowDeterminismState = {
    ...baseState,
    updates: [
      {
        updateId: 'upd-accepted',
        stage: 'accepted',
        handlerName: 'setTitle',
        identity: 'client-sdk',
        messageId: 'message-1',
        sequencingEventId: '1',
      },
      {
        updateId: 'upd-completed',
        stage: 'completed',
        identity: 'client-sdk',
        messageId: 'message-2',
        outcome: 'success',
        acceptedEventId: '42',
      },
    ],
  }

  const actual: WorkflowDeterminismState = {
    ...baseState,
    updates: [
      {
        updateId: 'upd-accepted',
        stage: 'accepted',
        handlerName: 'setTitle',
        identity: 'client-sdk',
        messageId: 'message-1',
        sequencingEventId: '1',
      },
      {
        updateId: 'upd-completed',
        stage: 'completed',
        identity: 'client-sdk',
        messageId: 'message-2',
        outcome: 'success',
      },
    ],
  }

  const diff = await Effect.runPromise(diffDeterminismState(expected, actual))
  expect(diff.mismatches).toEqual([])

  const expectedCompletionOnly: WorkflowDeterminismState = {
    ...baseState,
    updates: [
      {
        updateId: 'upd-completed',
        stage: 'completed',
        identity: 'client-sdk',
        messageId: 'message-keep',
        outcome: 'success',
      },
    ],
  }
  const mismatchedMessage: WorkflowDeterminismState = {
    ...baseState,
    updates: [
      {
        updateId: 'upd-completed',
        stage: 'completed',
        identity: 'client-sdk',
        messageId: 'message-mismatch',
        outcome: 'success',
      },
    ],
  }
  const diffWithMessageMismatch = await Effect.runPromise(
    diffDeterminismState(expectedCompletionOnly, mismatchedMessage),
  )
  expect(diffWithMessageMismatch.mismatches).toEqual([
    expect.objectContaining({ kind: 'update', index: 0 }),
  ])
})

test('ingestWorkflowHistory ingests record markers and search attribute upserts', async () => {
  const converter = createDefaultDataConverter()
  const info: WorkflowInfo = {
    namespace: 'default',
    taskQueue: 'replay-fixtures',
    workflowId: 'wf-marker',
    runId: 'run-marker',
    workflowType: 'workflowWithMarkers',
  }

  const markerPayloads = await encodeValuesToPayloads(converter, ['cached-value'])
  const markerEvent = create(HistoryEventSchema, {
    eventId: 1n,
    eventType: EventType.MARKER_RECORDED,
    attributes: {
      case: 'markerRecordedEventAttributes',
      value: create(MarkerRecordedEventAttributesSchema, {
        markerName: 'temporal-bun-sdk/side-effect',
        details: {
          result: create(PayloadsSchema, { payloads: markerPayloads ?? [] }),
        },
      }),
    },
  })

  const searchAttributePayloads = await encodeValuesToPayloads(converter, ['v1'])
  const searchAttributePayload = searchAttributePayloads?.[0]
  const upsertEvent = create(HistoryEventSchema, {
    eventId: 2n,
    eventType: EventType.UPSERT_WORKFLOW_SEARCH_ATTRIBUTES,
    attributes: {
      case: 'upsertWorkflowSearchAttributesEventAttributes',
      value: create(UpsertWorkflowSearchAttributesEventAttributesSchema, {
        workflowTaskCompletedEventId: 2n,
        searchAttributes: {
          indexedFields: {
            CustomKeywordField: searchAttributePayload ?? create(PayloadSchema, { metadata: {}, data: new Uint8Array() }),
          },
        },
      }),
    },
  })

  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info,
      history: [markerEvent, upsertEvent],
      dataConverter: converter,
    }),
  )

  expect(replay.determinismState.commandHistory).toHaveLength(2)
  const [markerIntent, upsertIntent] = replay.determinismState.commandHistory.map((entry) => entry.intent)

  expect(markerIntent.kind).toBe('record-marker')
  if (markerIntent.kind === 'record-marker') {
    expect(markerIntent.markerName).toBe('temporal-bun-sdk/side-effect')
    expect(markerIntent.details?.result).toBe('cached-value')
  }

  expect(upsertIntent.kind).toBe('upsert-search-attributes')
  if (upsertIntent.kind === 'upsert-search-attributes') {
    expect(upsertIntent.searchAttributes).toEqual({ CustomKeywordField: 'v1' })
  }
})

test('ingestWorkflowHistory returns marker state for determinism markers', async () => {
  const converter = createDefaultDataConverter()
  const info: WorkflowInfo = {
    namespace: 'default',
    taskQueue: 'replay-fixtures',
    workflowId: 'wf-marker-state',
    runId: 'run-marker-state',
    workflowType: 'markerStateWorkflow',
  }
  const determinismState: WorkflowDeterminismState = {
    commandHistory: [
      {
        intent: {
          kind: 'start-timer',
          id: 'timer-0',
          sequence: 0,
          timerId: 'timer-0',
          timeoutMs: 500,
        },
      },
    ],
    randomValues: [],
    timeValues: [],
    signals: [],
    queries: [],
  }

  const details = await Effect.runPromise(
    encodeDeterminismMarkerDetails(converter, {
      info,
      determinismState,
      lastEventId: '10',
      recordedAt: new Date('2025-01-01T00:00:00Z'),
    }),
  )

  const markerEvent = create(HistoryEventSchema, {
    eventId: 10n,
    eventType: EventType.MARKER_RECORDED,
    attributes: {
      case: 'markerRecordedEventAttributes',
      value: create(MarkerRecordedEventAttributesSchema, {
        markerName: 'temporal-bun-sdk/determinism',
        details,
      }),
    },
  })

  const timerEvent = create(HistoryEventSchema, {
    eventId: 1n,
    eventType: EventType.TIMER_STARTED,
    attributes: {
      case: 'timerStartedEventAttributes',
      value: create(TimerStartedEventAttributesSchema, {
        timerId: 'timer-0',
        startToFireTimeout: { seconds: 0n, nanos: 500_000_000 },
        workflowTaskCompletedEventId: 1n,
      }),
    },
  })

  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info,
      history: [timerEvent, markerEvent],
      dataConverter: converter,
    }),
  )

  expect(replay.markerState).toEqual(determinismState)
})

test('resolveHistoryLastEventId normalizes bigint identifiers', () => {
  const event = create(HistoryEventSchema, { eventId: 123n })
  expect(resolveHistoryLastEventId([event])).toBe('123')
  expect(resolveHistoryLastEventId([])).toBeNull()
})
