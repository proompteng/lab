import { expect, test } from 'bun:test'
import { create } from '@bufbuild/protobuf'
import { Effect } from 'effect'

import { createDefaultDataConverter } from '../../src/common/payloads'
import type { WorkflowInfo } from '../../src/workflow/context'
import { encodeDeterminismMarkerDetails, ingestWorkflowHistory } from '../../src/workflow/replay'
import type { WorkflowDeterminismState } from '../../src/workflow/determinism'
import { EventType } from '../../src/proto/temporal/api/enums/v1/event_type_pb'
import { UpdateAdmittedEventOrigin } from '../../src/proto/temporal/api/enums/v1/update_pb'
import {
  FailureSchema,
} from '../../src/proto/temporal/api/failure/v1/message_pb'
import {
  HistoryEventSchema,
  MarkerRecordedEventAttributesSchema,
  WorkflowExecutionUpdateAcceptedEventAttributesSchema,
  WorkflowExecutionUpdateAdmittedEventAttributesSchema,
  WorkflowExecutionUpdateCompletedEventAttributesSchema,
  WorkflowExecutionUpdateRejectedEventAttributesSchema,
} from '../../src/proto/temporal/api/history/v1/message_pb'
import { PayloadsSchema } from '../../src/proto/temporal/api/common/v1/message_pb'
import {
  OutcomeSchema,
  RequestSchema,
} from '../../src/proto/temporal/api/update/v1/message_pb'

const WORKFLOW_INFO: WorkflowInfo = {
  namespace: 'default',
  taskQueue: 'updates',
  workflowId: 'determinism-updates',
  runId: 'run-1',
  workflowType: 'sampleWorkflow',
}

const dataConverter = createDefaultDataConverter()

const makeUpdateRequest = (updateId: string, handlerName: string) =>
  create(RequestSchema, {
    meta: { updateId, identity: 'client-sdk' },
    input: { name: handlerName },
  })

const makeOutcome = (status: 'success' | 'failure') =>
  create(OutcomeSchema, {
    value:
      status === 'success'
        ? { case: 'success', value: create(PayloadsSchema, { payloads: [] }) }
        : { case: 'failure', value: create(FailureSchema, { message: 'rejected' }) },
  })

test('ingestWorkflowHistory records update lifecycle events', async () => {
  const events = [
    create(HistoryEventSchema, {
      eventId: 1n,
      eventType: EventType.WORKFLOW_EXECUTION_UPDATE_ADMITTED,
      attributes: {
        case: 'workflowExecutionUpdateAdmittedEventAttributes',
        value: create(WorkflowExecutionUpdateAdmittedEventAttributesSchema, {
          request: makeUpdateRequest('upd-1', 'setTitle'),
          origin: UpdateAdmittedEventOrigin.UPDATE_ADMITTED_EVENT_ORIGIN_CLIENT,
        }),
      },
    }),
    create(HistoryEventSchema, {
      eventId: 2n,
      eventType: EventType.WORKFLOW_EXECUTION_UPDATE_ACCEPTED,
      attributes: {
        case: 'workflowExecutionUpdateAcceptedEventAttributes',
        value: create(WorkflowExecutionUpdateAcceptedEventAttributesSchema, {
          acceptedRequest: makeUpdateRequest('upd-1', 'setTitle'),
          acceptedRequestMessageId: 'message-1',
          acceptedRequestSequencingEventId: 1n,
        }),
      },
    }),
    create(HistoryEventSchema, {
      eventId: 3n,
      eventType: EventType.WORKFLOW_EXECUTION_UPDATE_COMPLETED,
      attributes: {
        case: 'workflowExecutionUpdateCompletedEventAttributes',
        value: create(WorkflowExecutionUpdateCompletedEventAttributesSchema, {
          meta: { updateId: 'upd-1', identity: 'client-sdk' },
          acceptedEventId: 2n,
          outcome: makeOutcome('success'),
        }),
      },
    }),
  ]

  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info: WORKFLOW_INFO,
      history: events,
      dataConverter,
    }),
  )

  expect(replay.determinismState.updates).toEqual([
    {
      updateId: 'upd-1',
      stage: 'admitted',
      handlerName: 'setTitle',
      identity: 'client-sdk',
      historyEventId: '1',
    },
    {
      updateId: 'upd-1',
      stage: 'accepted',
      handlerName: 'setTitle',
      identity: 'client-sdk',
      messageId: 'message-1',
      sequencingEventId: '1',
      historyEventId: '2',
    },
    {
      updateId: 'upd-1',
      stage: 'completed',
      identity: 'client-sdk',
      acceptedEventId: '2',
      outcome: 'success',
      historyEventId: '3',
    },
  ])
})

test('ingestWorkflowHistory captures update rejection metadata', async () => {
  const events = [
    create(HistoryEventSchema, {
      eventId: 10n,
      eventType: EventType.WORKFLOW_EXECUTION_UPDATE_ADMITTED,
      attributes: {
        case: 'workflowExecutionUpdateAdmittedEventAttributes',
        value: create(WorkflowExecutionUpdateAdmittedEventAttributesSchema, {
          request: makeUpdateRequest('upd-2', 'setStatus'),
          origin: UpdateAdmittedEventOrigin.UPDATE_ADMITTED_EVENT_ORIGIN_CLIENT,
        }),
      },
    }),
    create(HistoryEventSchema, {
      eventId: 11n,
      eventType: EventType.WORKFLOW_EXECUTION_UPDATE_REJECTED,
      attributes: {
        case: 'workflowExecutionUpdateRejectedEventAttributes',
        value: create(WorkflowExecutionUpdateRejectedEventAttributesSchema, {
          rejectedRequest: makeUpdateRequest('upd-2', 'setStatus'),
          rejectedRequestMessageId: 'message-2',
          rejectedRequestSequencingEventId: 10n,
          failure: create(FailureSchema, { message: 'not allowed' }),
        }),
      },
    }),
  ]

  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info: WORKFLOW_INFO,
      history: events,
      dataConverter,
    }),
  )

  expect(replay.determinismState.updates).toEqual([
    {
      updateId: 'upd-2',
      stage: 'admitted',
      handlerName: 'setStatus',
      identity: 'client-sdk',
      historyEventId: '10',
    },
    {
      updateId: 'upd-2',
      stage: 'rejected',
      handlerName: 'setStatus',
      identity: 'client-sdk',
      messageId: 'message-2',
      sequencingEventId: '10',
      failureMessage: 'not allowed',
      historyEventId: '11',
    },
  ])
})

test('ingestWorkflowHistory dedupes update invocations and orders by sequencing id', async () => {
  const events = [
    create(HistoryEventSchema, {
      eventId: 1n,
      eventType: EventType.WORKFLOW_EXECUTION_UPDATE_ADMITTED,
      attributes: {
        case: 'workflowExecutionUpdateAdmittedEventAttributes',
        value: create(WorkflowExecutionUpdateAdmittedEventAttributesSchema, {
          request: makeUpdateRequest('upd-a', 'setTitle'),
          origin: UpdateAdmittedEventOrigin.UPDATE_ADMITTED_EVENT_ORIGIN_CLIENT,
        }),
      },
    }),
    create(HistoryEventSchema, {
      eventId: 2n,
      eventType: EventType.WORKFLOW_EXECUTION_UPDATE_ACCEPTED,
      attributes: {
        case: 'workflowExecutionUpdateAcceptedEventAttributes',
        value: create(WorkflowExecutionUpdateAcceptedEventAttributesSchema, {
          acceptedRequest: makeUpdateRequest('upd-a', 'setTitle'),
          acceptedRequestMessageId: 'message-a',
          acceptedRequestSequencingEventId: 1n,
        }),
      },
    }),
    create(HistoryEventSchema, {
      eventId: 3n,
      eventType: EventType.WORKFLOW_EXECUTION_UPDATE_ACCEPTED,
      attributes: {
        case: 'workflowExecutionUpdateAcceptedEventAttributes',
        value: create(WorkflowExecutionUpdateAcceptedEventAttributesSchema, {
          protocolInstanceId: 'proto-b',
          acceptedRequest: makeUpdateRequest('upd-b', 'setStatus'),
          acceptedRequestMessageId: 'message-b',
          acceptedRequestSequencingEventId: 3n,
        }),
      },
    }),
  ]

  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info: WORKFLOW_INFO,
      history: events,
      dataConverter,
    }),
  )

  expect(replay.updates).toEqual([
    {
      protocolInstanceId: 'history-admitted',
      requestMessageId: 'history-1',
      updateId: 'upd-a',
      name: 'setTitle',
      payload: undefined,
      identity: 'client-sdk',
      sequencingEventId: '1',
    },
    {
      protocolInstanceId: 'proto-b',
      requestMessageId: 'message-b',
      updateId: 'upd-b',
      name: 'setStatus',
      payload: undefined,
      identity: 'client-sdk',
      sequencingEventId: '3',
    },
  ])
})

test('ingestWorkflowHistory retains update invocations when marker covers history', async () => {
  const determinismState: WorkflowDeterminismState = {
    commandHistory: [],
    randomValues: [],
    timeValues: [],
    signals: [],
    queries: [],
    updates: [
      {
        updateId: 'upd-marker',
        stage: 'admitted',
        handlerName: 'setTitle',
        identity: 'client-sdk',
        historyEventId: '1',
      },
    ],
  }
  const markerDetails = await Effect.runPromise(
    encodeDeterminismMarkerDetails(dataConverter, {
      info: WORKFLOW_INFO,
      determinismState,
      lastEventId: '3',
      recordedAt: new Date('2025-01-01T00:00:00Z'),
    }),
  )

  const events = [
    create(HistoryEventSchema, {
      eventId: 1n,
      eventType: EventType.WORKFLOW_EXECUTION_UPDATE_ADMITTED,
      attributes: {
        case: 'workflowExecutionUpdateAdmittedEventAttributes',
        value: create(WorkflowExecutionUpdateAdmittedEventAttributesSchema, {
          request: makeUpdateRequest('upd-marker', 'setTitle'),
          origin: UpdateAdmittedEventOrigin.UPDATE_ADMITTED_EVENT_ORIGIN_CLIENT,
        }),
      },
    }),
    create(HistoryEventSchema, {
      eventId: 2n,
      eventType: EventType.WORKFLOW_EXECUTION_UPDATE_ACCEPTED,
      attributes: {
        case: 'workflowExecutionUpdateAcceptedEventAttributes',
        value: create(WorkflowExecutionUpdateAcceptedEventAttributesSchema, {
          acceptedRequest: makeUpdateRequest('upd-marker', 'setTitle'),
          acceptedRequestMessageId: 'message-marker',
          acceptedRequestSequencingEventId: 1n,
        }),
      },
    }),
    create(HistoryEventSchema, {
      eventId: 3n,
      eventType: EventType.MARKER_RECORDED,
      attributes: {
        case: 'markerRecordedEventAttributes',
        value: create(MarkerRecordedEventAttributesSchema, {
          markerName: 'temporal-bun-sdk/determinism',
          details: markerDetails,
          workflowTaskCompletedEventId: 2n,
        }),
      },
    }),
  ]

  const replay = await Effect.runPromise(
    ingestWorkflowHistory({
      info: WORKFLOW_INFO,
      history: events,
      dataConverter,
    }),
  )

  expect(replay.updates).toEqual([
    {
      protocolInstanceId: 'history-admitted',
      requestMessageId: 'history-1',
      updateId: 'upd-marker',
      name: 'setTitle',
      payload: undefined,
      identity: 'client-sdk',
      sequencingEventId: '1',
    },
  ])
})
