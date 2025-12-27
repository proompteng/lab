import { create } from '@bufbuild/protobuf'
import { Effect } from 'effect'

import { durationToMillis } from '../common/duration'
import { type DataConverter, decodePayloadsToValues, encodeValuesToPayloads } from '../common/payloads'
import {
  type Memo,
  type Payloads,
  PayloadsSchema,
  type RetryPolicy,
  type SearchAttributes,
} from '../proto/temporal/api/common/v1/message_pb'
import { EventType } from '../proto/temporal/api/enums/v1/event_type_pb'
import { ParentClosePolicy, TimeoutType, WorkflowIdReusePolicy } from '../proto/temporal/api/enums/v1/workflow_pb'
import type { Failure } from '../proto/temporal/api/failure/v1/message_pb'
import type {
  ActivityTaskCancelRequestedEventAttributes,
  ActivityTaskScheduledEventAttributes,
  HistoryEvent,
  MarkerRecordedEventAttributes,
  RequestCancelExternalWorkflowExecutionInitiatedEventAttributes,
  SignalExternalWorkflowExecutionInitiatedEventAttributes,
  StartChildWorkflowExecutionInitiatedEventAttributes,
  TimerCanceledEventAttributes,
  TimerStartedEventAttributes,
  UpsertWorkflowSearchAttributesEventAttributes,
  WorkflowExecutionContinuedAsNewEventAttributes,
  WorkflowExecutionFailedEventAttributes,
  WorkflowExecutionSignaledEventAttributes,
  WorkflowExecutionTimedOutEventAttributes,
  WorkflowExecutionUpdateAcceptedEventAttributes,
  WorkflowExecutionUpdateAdmittedEventAttributes,
  WorkflowExecutionUpdateCompletedEventAttributes,
  WorkflowExecutionUpdateRejectedEventAttributes,
  WorkflowPropertiesModifiedEventAttributes,
  WorkflowTaskFailedEventAttributes,
  WorkflowTaskTimedOutEventAttributes,
} from '../proto/temporal/api/history/v1/message_pb'
import type { Outcome } from '../proto/temporal/api/update/v1/message_pb'
import type {
  CancelTimerCommandIntent,
  ContinueAsNewWorkflowCommandIntent,
  ModifyWorkflowPropertiesCommandIntent,
  RecordMarkerCommandIntent,
  RequestCancelActivityCommandIntent,
  RequestCancelExternalWorkflowCommandIntent,
  ScheduleActivityCommandIntent,
  SignalExternalWorkflowCommandIntent,
  StartChildWorkflowCommandIntent,
  StartTimerCommandIntent,
  UpsertSearchAttributesCommandIntent,
  WorkflowCommandIntent,
} from './commands'
import type { WorkflowInfo } from './context'
import type {
  WorkflowCommandHistoryEntry,
  WorkflowCommandHistoryEntryMetadata,
  WorkflowDeterminismFailureMetadata,
  WorkflowDeterminismQueryRecord,
  WorkflowDeterminismSignalRecord,
  WorkflowDeterminismState,
  WorkflowRetryPolicyInput,
  WorkflowUpdateDeterminismEntry,
  WorkflowUpdateDeterminismStage,
} from './determinism'
import { intentsEqual, stableStringify } from './determinism'
import type { WorkflowUpdateInvocation } from './executor'
import type { WorkflowQueryRequest } from './inbound'

export interface ReplayIntake {
  readonly info: WorkflowInfo
  readonly history: HistoryEvent[]
  readonly dataConverter: DataConverter
  readonly ignoreDeterminismMarker?: boolean
  readonly queries?: readonly WorkflowQueryRequest[]
}

export interface ReplayResult {
  readonly determinismState: WorkflowDeterminismState
  readonly lastEventId: string | null
  readonly hasDeterminismMarker: boolean
  readonly markerState?: WorkflowDeterminismState
  readonly updates?: readonly WorkflowUpdateInvocation[]
}

export interface DeterminismMarkerInput {
  readonly info: WorkflowInfo
  readonly determinismState: WorkflowDeterminismState
  readonly determinismDelta?: DeterminismStateDelta
  readonly markerType?: DeterminismMarkerType
  readonly lastEventId: string | null
  readonly recordedAt?: Date
}

export type DeterminismMarkerType = 'full' | 'delta'

export interface DeterminismStateDelta {
  readonly commandHistory?: WorkflowDeterminismState['commandHistory']
  readonly randomValues?: WorkflowDeterminismState['randomValues']
  readonly timeValues?: WorkflowDeterminismState['timeValues']
  readonly logCount?: number
  readonly failureMetadata?: WorkflowDeterminismFailureMetadata
  readonly signals?: WorkflowDeterminismState['signals']
  readonly queries?: WorkflowDeterminismState['queries']
  readonly updates?: WorkflowDeterminismState['updates']
}

export interface DeterminismMarkerEnvelopeV1 {
  readonly schemaVersion: 1
  readonly workflow: WorkflowInfo
  readonly determinismState: WorkflowDeterminismState
  readonly lastEventId: string | null
  readonly recordedAtIso: string
}

export interface DeterminismMarkerEnvelopeV2 {
  readonly schemaVersion: 2
  readonly workflow: WorkflowInfo
  readonly determinismState?: WorkflowDeterminismState
  readonly determinismDelta?: DeterminismStateDelta
  readonly lastEventId: string | null
  readonly recordedAtIso: string
}

export type DeterminismMarkerEnvelope = DeterminismMarkerEnvelopeV1 | DeterminismMarkerEnvelopeV2

export interface DeterminismDiffResult {
  readonly mismatches: DeterminismMismatch[]
}

export interface DeterminismMismatchCommand {
  readonly kind: 'command'
  readonly index: number
  readonly expected?: WorkflowCommandIntent
  readonly actual?: WorkflowCommandIntent
  readonly expectedEventId?: string | null
  readonly actualEventId?: string | null
  readonly workflowTaskCompletedEventId?: string | null
  readonly eventType?: EventType
}

export interface DeterminismMismatchRandom {
  readonly kind: 'random'
  readonly index: number
  readonly expected?: number
  readonly actual?: number
}

export interface DeterminismMismatchTime {
  readonly kind: 'time'
  readonly index: number
  readonly expected?: number
  readonly actual?: number
}

export interface DeterminismMismatchSignal {
  readonly kind: 'signal'
  readonly index: number
  readonly expected?: WorkflowDeterminismSignalRecord
  readonly actual?: WorkflowDeterminismSignalRecord
}

export interface DeterminismMismatchQuery {
  readonly kind: 'query'
  readonly index: number
  readonly expected?: WorkflowDeterminismQueryRecord
  readonly actual?: WorkflowDeterminismQueryRecord
}

export interface DeterminismMismatchUpdate {
  readonly kind: 'update'
  readonly index: number
  readonly expected?: WorkflowUpdateDeterminismEntry
  readonly actual?: WorkflowUpdateDeterminismEntry
}

export type DeterminismMismatch =
  | DeterminismMismatchCommand
  | DeterminismMismatchRandom
  | DeterminismMismatchTime
  | DeterminismMismatchSignal
  | DeterminismMismatchQuery
  | DeterminismMismatchUpdate

export const DETERMINISM_MARKER_NAME = 'temporal-bun-sdk/determinism'

const DETERMINISM_MARKER_SCHEMA_VERSION_V1 = 1
const DETERMINISM_MARKER_SCHEMA_VERSION_V2 = 2
const DETERMINISM_MARKER_DETAIL_KEY = 'snapshot'

/**
 * Encode a workflow determinism snapshot into a marker payload map suitable for
 * use with {@link RecordMarkerCommandAttributes.details}.
 */
export const encodeDeterminismMarkerDetails = (
  converter: DataConverter,
  input: DeterminismMarkerInput,
): Effect.Effect<Record<string, Payloads>, unknown, never> =>
  Effect.tryPromise(async () => {
    const recordedAt = (input.recordedAt ?? new Date()).toISOString()
    const markerType: DeterminismMarkerType = input.markerType ?? 'full'
    if (markerType === 'delta' && !input.determinismDelta) {
      throw new Error('Determinism marker delta payload missing')
    }
    const envelope: DeterminismMarkerEnvelope =
      markerType === 'delta'
        ? {
            schemaVersion: DETERMINISM_MARKER_SCHEMA_VERSION_V2,
            workflow: input.info,
            determinismDelta: input.determinismDelta,
            lastEventId: normalizeEventId(input.lastEventId),
            recordedAtIso: recordedAt,
          }
        : {
            schemaVersion: DETERMINISM_MARKER_SCHEMA_VERSION_V1,
            workflow: input.info,
            determinismState: input.determinismState,
            lastEventId: normalizeEventId(input.lastEventId),
            recordedAtIso: recordedAt,
          }

    const payloads = await encodeValuesToPayloads(converter, [envelope])
    if (!payloads || payloads.length === 0) {
      throw new Error('Failed to encode determinism marker payloads')
    }

    return {
      [DETERMINISM_MARKER_DETAIL_KEY]: create(PayloadsSchema, { payloads }),
    }
  })

export const measurePayloadsByteSize = (details: Record<string, Payloads>): number => {
  let total = 0
  for (const payloads of Object.values(details)) {
    for (const payload of payloads.payloads ?? []) {
      total += payload.data?.byteLength ?? 0
      const metadata = payload.metadata ?? {}
      for (const value of Object.values(metadata)) {
        total += value?.byteLength ?? 0
      }
    }
  }
  return total
}

export const encodeDeterminismMarkerDetailsWithSize = (
  converter: DataConverter,
  input: DeterminismMarkerInput,
): Effect.Effect<{ details: Record<string, Payloads>; sizeBytes: number }, unknown, never> =>
  encodeDeterminismMarkerDetails(converter, input).pipe(
    Effect.map((details) => ({ details, sizeBytes: measurePayloadsByteSize(details) })),
  )

export interface DecodeDeterminismMarkerInput {
  readonly converter: DataConverter
  readonly details: Record<string, Payloads> | undefined
}

/**
 * Decode determinism snapshot metadata from a marker payload map. Returns
 * `undefined` when the supplied details do not contain a determinism snapshot.
 */
export const decodeDeterminismMarkerEnvelope = (
  input: DecodeDeterminismMarkerInput,
): Effect.Effect<DeterminismMarkerEnvelope | undefined, unknown, never> =>
  Effect.tryPromise(async () => {
    const snapshot = input.details?.[DETERMINISM_MARKER_DETAIL_KEY]
    if (!snapshot) {
      return undefined
    }

    const values = await decodePayloadsToValues(input.converter, snapshot.payloads ?? [])
    if (!values || values.length === 0) {
      return undefined
    }

    const envelope = values[0]
    if (!isRecord(envelope)) {
      throw new Error('Determinism marker payload was not an object')
    }

    return sanitizeDeterminismMarkerEnvelope(envelope)
  })

/**
 * Processes workflow history into a determinism snapshot that can seed the
 * {@link DeterminismGuard}. Downstream tasks populate sticky caches and replay
 * diagnostics from the returned state.
 */
export const ingestWorkflowHistory = (intake: ReplayIntake): Effect.Effect<ReplayResult, unknown, never> =>
  Effect.gen(function* () {
    const events = sortHistoryEvents(intake.history ?? [])
    const shouldUseDeterminismMarker = intake.ignoreDeterminismMarker !== true
    let markerState: WorkflowDeterminismState | undefined
    let markerLastEventId: string | null = null
    let markerEventId: string | null = null
    let markerEventIndex: number | null = null
    let markerInvalid = false
    let hasMarker = false

    if (shouldUseDeterminismMarker) {
      for (const [index, event] of events.entries()) {
        if (event.eventType !== EventType.MARKER_RECORDED) {
          continue
        }
        if (event.attributes?.case !== 'markerRecordedEventAttributes') {
          continue
        }

        const decoded = yield* Effect.catchAll(
          decodeDeterminismMarkerEnvelope({
            converter: intake.dataConverter,
            details: event.attributes.value.details,
          }),
          () => Effect.succeed<DeterminismMarkerEnvelope | undefined>(undefined),
        )

        if (decoded) {
          const applied = applyDeterminismMarker(markerState, decoded)
          if (!applied) {
            markerInvalid = true
            break
          }
          markerState = applied
          markerLastEventId = decoded.lastEventId
          markerEventId = normalizeEventId(event.eventId)
          markerEventIndex = index
          hasMarker = true
        }
      }
    }

    const extractedFailureMetadata = extractFailureMetadata(events)
    const historyLastEventId = resolveHistoryLastEventId(events) ?? null
    const eventsAfterMarker =
      shouldUseDeterminismMarker && hasMarker && markerEventIndex !== null ? events.slice(markerEventIndex + 1) : events
    const replayUpdateInvocationsAfterMarker = yield* Effect.tryPromise(async () =>
      collectWorkflowUpdateInvocations(eventsAfterMarker, intake.dataConverter),
    )
    const updateEntriesAfterMarker = collectWorkflowUpdateEntries(eventsAfterMarker)
    const replayUpdateInvocationsFull = yield* Effect.tryPromise(async () =>
      collectWorkflowUpdateInvocations(events, intake.dataConverter),
    )
    const updateEntriesFull = collectWorkflowUpdateEntries(events)

    const markerCoversHistory = markerEventId !== null && markerEventId === historyLastEventId
    const historyCommandCount = countHistoryCommandEvents(events)

    if (shouldUseDeterminismMarker && hasMarker && !markerInvalid && markerState) {
      if (markerCoversHistory || eventsAfterMarker.length === 0) {
        let determinismState = cloneDeterminismState(markerState)
        if (!determinismState.failureMetadata && extractedFailureMetadata) {
          determinismState = {
            ...determinismState,
            failureMetadata: extractedFailureMetadata,
          }
        }
        if (
          (!determinismState.updates || determinismState.updates.length === 0) &&
          updateEntriesAfterMarker.length > 0
        ) {
          determinismState = {
            ...determinismState,
            updates: updateEntriesAfterMarker,
          }
        }
        determinismState = mergePendingQueryRequests(determinismState, intake.queries)
        const latestEventId = historyLastEventId ?? markerLastEventId ?? null
        if (determinismState.commandHistory.length !== historyCommandCount) {
          return yield* reconstructDeterminismState(
            events,
            intake,
            extractedFailureMetadata,
            updateEntriesFull,
            replayUpdateInvocationsFull,
          )
        }
        return {
          determinismState,
          lastEventId: latestEventId,
          hasDeterminismMarker: true,
          markerState: cloneDeterminismState(markerState),
          ...(replayUpdateInvocationsAfterMarker.length > 0 ? { updates: replayUpdateInvocationsAfterMarker } : {}),
        }
      }

      const replayed = yield* reconstructDeterminismState(
        eventsAfterMarker,
        intake,
        extractedFailureMetadata,
        updateEntriesAfterMarker,
        replayUpdateInvocationsAfterMarker,
        {
          seedState: markerState,
          historyLastEventId,
          seedHistoryEvents: markerEventIndex !== null ? events.slice(0, markerEventIndex + 1) : undefined,
        },
      )
      if (replayed.determinismState.commandHistory.length !== historyCommandCount) {
        return yield* reconstructDeterminismState(
          events,
          intake,
          extractedFailureMetadata,
          updateEntriesFull,
          replayUpdateInvocationsFull,
        )
      }
      return {
        ...replayed,
        hasDeterminismMarker: true,
        markerState: cloneDeterminismState(markerState),
        lastEventId: historyLastEventId ?? markerLastEventId ?? null,
      }
    }

    return yield* reconstructDeterminismState(
      events,
      intake,
      extractedFailureMetadata,
      updateEntriesFull,
      replayUpdateInvocationsFull,
    )
  })

/**
 * Diff determinism state against freshly emitted intents to produce rich
 * diagnostics for `WorkflowNondeterminismError` instances.
 */
export const diffDeterminismState = (
  expected: WorkflowDeterminismState,
  actual: WorkflowDeterminismState,
): Effect.Effect<DeterminismDiffResult, never, never> =>
  Effect.sync(() => {
    const mismatches: DeterminismMismatch[] = []

    const maxCommands = Math.max(expected.commandHistory.length, actual.commandHistory.length)
    for (let index = 0; index < maxCommands; index += 1) {
      const expectedEntry = expected.commandHistory[index]
      const actualEntry = actual.commandHistory[index]
      const expectedIntent = expectedEntry?.intent
      const actualIntent = actualEntry?.intent
      const metadata = resolveCommandMismatchMetadata(expectedEntry, actualEntry)
      if (!expectedIntent || !actualIntent) {
        if (expectedIntent !== actualIntent) {
          mismatches.push({
            kind: 'command',
            index,
            expected: expectedIntent,
            actual: actualIntent,
            ...metadata,
          })
        }
        continue
      }
      if (!intentsEqual(expectedIntent, actualIntent)) {
        mismatches.push({
          kind: 'command',
          index,
          expected: expectedIntent,
          actual: actualIntent,
          ...metadata,
        })
      }
    }

    const maxRandom = Math.max(expected.randomValues.length, actual.randomValues.length)
    for (let index = 0; index < maxRandom; index += 1) {
      const expectedValue = expected.randomValues[index]
      const actualValue = actual.randomValues[index]
      if (!valuesEqual(expectedValue, actualValue)) {
        mismatches.push({
          kind: 'random',
          index,
          expected: expectedValue,
          actual: actualValue,
        })
      }
    }

    const maxTime = Math.max(expected.timeValues.length, actual.timeValues.length)
    for (let index = 0; index < maxTime; index += 1) {
      const expectedValue = expected.timeValues[index]
      const actualValue = actual.timeValues[index]
      if (!valuesEqual(expectedValue, actualValue)) {
        mismatches.push({
          kind: 'time',
          index,
          expected: expectedValue,
          actual: actualValue,
        })
      }
    }

    const expectedSignals = expected.signals ?? []
    const actualSignals = actual.signals ?? []
    const maxSignals = Math.max(expectedSignals.length, actualSignals.length)
    for (let index = 0; index < maxSignals; index += 1) {
      const expectedSignal = expectedSignals[index]
      const actualSignal = actualSignals[index]
      if (!recordsMatch(expectedSignal, actualSignal)) {
        mismatches.push({ kind: 'signal', index, expected: expectedSignal, actual: actualSignal })
      }
    }

    const expectedQueries = expected.queries ?? []
    const actualQueries = actual.queries ?? []
    const maxQueries = Math.max(expectedQueries.length, actualQueries.length)
    for (let index = 0; index < maxQueries; index += 1) {
      const expectedQuery = expectedQueries[index]
      const actualQuery = actualQueries[index]
      if (!recordsMatch(expectedQuery, actualQuery)) {
        mismatches.push({ kind: 'query', index, expected: expectedQuery, actual: actualQuery })
      }
    }

    const expectedUpdates = expected.updates ?? []
    const actualUpdates = actual.updates ?? []
    const maxUpdates = Math.max(expectedUpdates.length, actualUpdates.length)
    for (let index = 0; index < maxUpdates; index += 1) {
      const expectedEntry = expectedUpdates[index]
      const actualEntry = actualUpdates[index]
      if (!updatesEqual(expectedEntry, actualEntry)) {
        mismatches.push({ kind: 'update', index, expected: expectedEntry, actual: actualEntry })
      }
    }

    return { mismatches }
  })

export const resolveHistoryLastEventId = (events: HistoryEvent[]): string | null => {
  if (!events || events.length === 0) {
    return null
  }
  const last = events[events.length - 1]
  if (!last) {
    return null
  }
  const { eventId } = last
  if (eventId === undefined || eventId === null) {
    return null
  }
  if (typeof eventId === 'number' && !Number.isFinite(eventId)) {
    return null
  }
  return String(eventId)
}

export const cloneDeterminismState = (state: WorkflowDeterminismState): WorkflowDeterminismState => ({
  commandHistory: state.commandHistory.map((entry) => ({
    intent: entry.intent,
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  })),
  randomValues: [...state.randomValues],
  timeValues: [...state.timeValues],
  ...(state.logCount !== undefined ? { logCount: state.logCount } : {}),
  failureMetadata: state.failureMetadata ? { ...state.failureMetadata } : undefined,
  signals: state.signals ? state.signals.map((record) => ({ ...record })) : [],
  queries: state.queries ? state.queries.map((record) => ({ ...record })) : [],
  updates: state.updates ? state.updates.map((entry) => ({ ...entry })) : undefined,
})

const sortHistoryEvents = (events: HistoryEvent[]): HistoryEvent[] =>
  events.slice().sort((left, right) => {
    const leftId = resolveEventIdForSort(left)
    const rightId = resolveEventIdForSort(right)
    if (leftId === rightId) {
      return 0
    }
    return leftId < rightId ? -1 : 1
  })

const resolveEventIdForSort = (event: HistoryEvent): bigint => {
  const eventId: unknown = event.eventId
  if (typeof eventId === 'bigint') {
    return eventId
  }
  if (typeof eventId === 'number' && Number.isFinite(eventId)) {
    return BigInt(eventId)
  }
  if (typeof eventId === 'string' && eventId.length > 0) {
    try {
      return BigInt(eventId)
    } catch {
      return 0n
    }
  }
  return 0n
}

const buildCommandMetadata = (
  event: HistoryEvent,
  attributes: unknown,
): WorkflowCommandHistoryEntryMetadata | undefined => {
  const eventId = normalizeEventId(event.eventId)
  const workflowTaskCompletedEventId = resolveWorkflowTaskCompletedEventId(attributes)
  const eventType = event.eventType
  if (!eventId && !workflowTaskCompletedEventId && (eventType === undefined || eventType === EventType.UNSPECIFIED)) {
    return undefined
  }
  return {
    ...(eventId !== null ? { eventId } : {}),
    ...(typeof eventType === 'number' ? { eventType } : {}),
    ...(workflowTaskCompletedEventId ? { workflowTaskCompletedEventId } : {}),
  }
}

const resolveWorkflowTaskCompletedEventId = (attributes: unknown): string | null => {
  if (!attributes || typeof attributes !== 'object') {
    return null
  }
  const candidate = (attributes as { workflowTaskCompletedEventId?: unknown }).workflowTaskCompletedEventId
  if (candidate === undefined || candidate === null) {
    return null
  }
  try {
    return normalizeEventId(candidate)
  } catch {
    return null
  }
}

const extractFailureMetadata = (events: HistoryEvent[]): WorkflowDeterminismFailureMetadata | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const metadata = buildFailureMetadata(events[index])
    if (metadata) {
      return metadata
    }
  }
  return undefined
}

const buildFailureMetadata = (event: HistoryEvent): WorkflowDeterminismFailureMetadata | undefined => {
  const eventId = normalizeEventId(event.eventId)
  switch (event.eventType) {
    case EventType.WORKFLOW_EXECUTION_FAILED: {
      if (event.attributes?.case !== 'workflowExecutionFailedEventAttributes') {
        return undefined
      }
      const attributes = event.attributes.value as WorkflowExecutionFailedEventAttributes
      return {
        eventId,
        eventType: event.eventType,
        failureType: resolveFailureType(attributes.failure),
        failureMessage: attributes.failure?.message ?? undefined,
        retryState: attributes.retryState !== undefined ? Number(attributes.retryState) : undefined,
      }
    }
    case EventType.WORKFLOW_EXECUTION_TIMED_OUT: {
      if (event.attributes?.case !== 'workflowExecutionTimedOutEventAttributes') {
        return undefined
      }
      const attributes = event.attributes.value as WorkflowExecutionTimedOutEventAttributes
      return {
        eventId,
        eventType: event.eventType,
        failureType: 'WORKFLOW_EXECUTION_TIMED_OUT',
        failureMessage: undefined,
        retryState: attributes.retryState !== undefined ? Number(attributes.retryState) : undefined,
      }
    }
    case EventType.WORKFLOW_TASK_FAILED: {
      if (event.attributes?.case !== 'workflowTaskFailedEventAttributes') {
        return undefined
      }
      const attributes = event.attributes.value as WorkflowTaskFailedEventAttributes
      return {
        eventId,
        eventType: event.eventType,
        failureType: resolveFailureType(attributes.failure),
        failureMessage: attributes.failure?.message ?? undefined,
      }
    }
    case EventType.WORKFLOW_TASK_TIMED_OUT: {
      if (event.attributes?.case !== 'workflowTaskTimedOutEventAttributes') {
        return undefined
      }
      const attributes = event.attributes.value as WorkflowTaskTimedOutEventAttributes
      const timeoutTypeName = TimeoutType[attributes.timeoutType] ?? 'TIMEOUT_TYPE_UNSPECIFIED'
      return {
        eventId,
        eventType: event.eventType,
        failureType: `WORKFLOW_TASK_TIMED_OUT:${timeoutTypeName}`,
      }
    }
    default:
      return undefined
  }
}

const resolveFailureType = (failure: Failure | undefined): string | undefined => {
  if (!failure) {
    return undefined
  }
  switch (failure.failureInfo?.case) {
    case 'applicationFailureInfo':
      return failure.failureInfo.value.type || 'ApplicationFailure'
    case 'timeoutFailureInfo': {
      const timeoutName = TimeoutType[failure.failureInfo.value.timeoutType] ?? 'TIMEOUT_TYPE_UNSPECIFIED'
      return `Timeout:${timeoutName}`
    }
    case 'activityFailureInfo':
      return 'ActivityFailure'
    case 'childWorkflowExecutionFailureInfo':
      return 'ChildWorkflowFailure'
    case 'canceledFailureInfo':
      return 'CanceledFailure'
    case 'terminatedFailureInfo':
      return 'TerminatedFailure'
    case 'serverFailureInfo':
      return 'ServerFailure'
    case 'resetWorkflowFailureInfo':
      return 'ResetWorkflowFailure'
    default:
      return failure.failureInfo?.case ?? failure.source ?? failure.message ?? undefined
  }
}

const resolveCommandMismatchMetadata = (
  expectedEntry: WorkflowCommandHistoryEntry | undefined,
  actualEntry: WorkflowCommandHistoryEntry | undefined,
): Pick<
  DeterminismMismatchCommand,
  'expectedEventId' | 'actualEventId' | 'workflowTaskCompletedEventId' | 'eventType'
> => {
  const expectedMetadata = expectedEntry?.metadata
  const actualMetadata = actualEntry?.metadata
  const workflowTaskCompletedEventId =
    expectedMetadata?.workflowTaskCompletedEventId ?? actualMetadata?.workflowTaskCompletedEventId ?? null
  const eventType = expectedMetadata?.eventType ?? actualMetadata?.eventType
  return {
    expectedEventId: expectedMetadata?.eventId ?? null,
    actualEventId: actualMetadata?.eventId ?? null,
    workflowTaskCompletedEventId,
    eventType,
  }
}

type DeterminismReconstructionOptions = {
  readonly seedState?: WorkflowDeterminismState
  readonly historyLastEventId?: string | null
  readonly seedHistoryEvents?: readonly HistoryEvent[]
}

const seedDeterminismEventMaps = (state?: WorkflowDeterminismState, seedEvents?: readonly HistoryEvent[]) => {
  const scheduledActivities = new Map<string, string>()
  const timersByStartEventId = new Map<string, string>()

  if (!state) {
    if (seedEvents) {
      seedDeterminismEventMapsFromHistory(scheduledActivities, timersByStartEventId, seedEvents)
    }
    return { scheduledActivities, timersByStartEventId }
  }

  for (const entry of state.commandHistory) {
    const eventId = entry.metadata?.eventId
    if (!eventId) {
      continue
    }
    if (entry.intent.kind === 'schedule-activity') {
      scheduledActivities.set(eventId, entry.intent.activityId)
      continue
    }
    if (entry.intent.kind === 'start-timer') {
      timersByStartEventId.set(eventId, entry.intent.timerId)
    }
  }

  if (seedEvents) {
    seedDeterminismEventMapsFromHistory(scheduledActivities, timersByStartEventId, seedEvents)
  }

  return { scheduledActivities, timersByStartEventId }
}

const seedDeterminismEventMapsFromHistory = (
  scheduledActivities: Map<string, string>,
  timersByStartEventId: Map<string, string>,
  events: readonly HistoryEvent[],
) => {
  for (const event of events) {
    switch (event.eventType) {
      case EventType.ACTIVITY_TASK_SCHEDULED: {
        if (event.attributes?.case !== 'activityTaskScheduledEventAttributes') {
          break
        }
        const activityId = event.attributes.value.activityId
        const eventId = normalizeEventId(event.eventId)
        if (activityId && eventId && !scheduledActivities.has(eventId)) {
          scheduledActivities.set(eventId, activityId)
        }
        break
      }
      case EventType.TIMER_STARTED: {
        if (event.attributes?.case !== 'timerStartedEventAttributes') {
          break
        }
        const timerId = event.attributes.value.timerId
        const eventId = normalizeEventId(event.eventId)
        if (timerId && eventId && !timersByStartEventId.has(eventId)) {
          timersByStartEventId.set(eventId, timerId)
        }
        break
      }
      default:
        break
    }
  }
}

const countHistoryCommandEvents = (events: readonly HistoryEvent[]): number => {
  const { scheduledActivities, timersByStartEventId } = seedDeterminismEventMaps(undefined, events)
  let count = 0

  for (const event of events) {
    switch (event.eventType) {
      case EventType.ACTIVITY_TASK_SCHEDULED: {
        if (event.attributes?.case !== 'activityTaskScheduledEventAttributes') {
          break
        }
        if (event.attributes.value.activityType?.name) {
          count += 1
        }
        break
      }
      case EventType.TIMER_STARTED: {
        if (event.attributes?.case !== 'timerStartedEventAttributes') {
          break
        }
        if (durationToMillis(event.attributes.value.startToFireTimeout) !== undefined) {
          count += 1
        }
        break
      }
      case EventType.START_CHILD_WORKFLOW_EXECUTION_INITIATED: {
        if (event.attributes?.case !== 'startChildWorkflowExecutionInitiatedEventAttributes') {
          break
        }
        if (event.attributes.value.workflowType?.name) {
          count += 1
        }
        break
      }
      case EventType.ACTIVITY_TASK_CANCEL_REQUESTED: {
        if (event.attributes?.case !== 'activityTaskCancelRequestedEventAttributes') {
          break
        }
        const scheduledEventId = normalizeBigintIdentifier(event.attributes.value.scheduledEventId)
        if (scheduledEventId && scheduledActivities.has(scheduledEventId)) {
          count += 1
        }
        break
      }
      case EventType.TIMER_CANCELED: {
        if (event.attributes?.case !== 'timerCanceledEventAttributes') {
          break
        }
        const startedEventId = normalizeBigintIdentifier(event.attributes.value.startedEventId)
        if (startedEventId && timersByStartEventId.has(startedEventId)) {
          count += 1
        }
        break
      }
      case EventType.SIGNAL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED: {
        if (event.attributes?.case !== 'signalExternalWorkflowExecutionInitiatedEventAttributes') {
          break
        }
        if (event.attributes.value.signalName) {
          count += 1
        }
        break
      }
      case EventType.REQUEST_CANCEL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED: {
        if (event.attributes?.case !== 'requestCancelExternalWorkflowExecutionInitiatedEventAttributes') {
          break
        }
        count += 1
        break
      }
      case EventType.WORKFLOW_EXECUTION_CONTINUED_AS_NEW: {
        if (event.attributes?.case !== 'workflowExecutionContinuedAsNewEventAttributes') {
          break
        }
        count += 1
        break
      }
      case EventType.MARKER_RECORDED: {
        if (event.attributes?.case !== 'markerRecordedEventAttributes') {
          break
        }
        if (event.attributes.value.markerName !== DETERMINISM_MARKER_NAME) {
          count += 1
        }
        break
      }
      case EventType.UPSERT_WORKFLOW_SEARCH_ATTRIBUTES: {
        if (event.attributes?.case !== 'upsertWorkflowSearchAttributesEventAttributes') {
          break
        }
        count += 1
        break
      }
      case EventType.WORKFLOW_PROPERTIES_MODIFIED: {
        if (event.attributes?.case !== 'workflowPropertiesModifiedEventAttributes') {
          break
        }
        count += 1
        break
      }
      default:
        break
    }
  }

  return count
}

const reconstructDeterminismState = (
  events: HistoryEvent[],
  intake: ReplayIntake,
  failureMetadata?: WorkflowDeterminismFailureMetadata,
  precomputedUpdates?: WorkflowUpdateDeterminismEntry[],
  replayUpdateInvocations: WorkflowUpdateInvocation[] = [],
  options?: DeterminismReconstructionOptions,
): Effect.Effect<ReplayResult, unknown, never> =>
  Effect.gen(function* () {
    const seededState = options?.seedState ? cloneDeterminismState(options.seedState) : undefined
    let sequence = seededState?.commandHistory.length ?? 0
    const commandHistory: WorkflowCommandHistoryEntry[] = seededState ? [...seededState.commandHistory] : []
    const signalRecords: WorkflowDeterminismSignalRecord[] = seededState ? [...seededState.signals] : []
    const queryRecords: WorkflowDeterminismQueryRecord[] = seededState ? [...seededState.queries] : []
    const updateEntries = precomputedUpdates ?? collectWorkflowUpdateEntries(events)
    const updates =
      seededState?.updates && seededState.updates.length > 0
        ? [...seededState.updates, ...updateEntries]
        : updateEntries
    const { scheduledActivities, timersByStartEventId } = seedDeterminismEventMaps(
      seededState,
      options?.seedHistoryEvents,
    )

    for (const event of events) {
      switch (event.eventType) {
        case EventType.ACTIVITY_TASK_SCHEDULED: {
          if (event.attributes?.case !== 'activityTaskScheduledEventAttributes') {
            break
          }
          const intent = yield* fromActivityTaskScheduled(event.attributes.value, sequence, intake)
          if (intent) {
            commandHistory.push({
              intent,
              metadata: buildCommandMetadata(event, event.attributes.value),
            })
            const scheduledKey = normalizeEventId(event.eventId)
            if (scheduledKey) {
              scheduledActivities.set(scheduledKey, intent.activityId)
            }
            sequence += 1
          }
          break
        }
        case EventType.TIMER_STARTED: {
          if (event.attributes?.case !== 'timerStartedEventAttributes') {
            break
          }
          const intent = fromTimerStarted(event.attributes.value, sequence)
          if (intent) {
            commandHistory.push({
              intent,
              metadata: buildCommandMetadata(event, event.attributes.value),
            })
            const startKey = normalizeEventId(event.eventId)
            if (startKey) {
              timersByStartEventId.set(startKey, intent.timerId)
            }
            sequence += 1
          }
          break
        }
        case EventType.START_CHILD_WORKFLOW_EXECUTION_INITIATED: {
          if (event.attributes?.case !== 'startChildWorkflowExecutionInitiatedEventAttributes') {
            break
          }
          const intent = yield* fromStartChildWorkflow(event.attributes.value, sequence, intake)
          if (intent) {
            commandHistory.push({
              intent,
              metadata: buildCommandMetadata(event, event.attributes.value),
            })
            sequence += 1
          }
          break
        }
        case EventType.ACTIVITY_TASK_CANCEL_REQUESTED: {
          if (event.attributes?.case !== 'activityTaskCancelRequestedEventAttributes') {
            break
          }
          const intent = fromActivityTaskCancelRequested(event.attributes.value, sequence, scheduledActivities)
          if (intent) {
            commandHistory.push({
              intent,
              metadata: buildCommandMetadata(event, event.attributes.value),
            })
            sequence += 1
          }
          break
        }
        case EventType.TIMER_CANCELED: {
          if (event.attributes?.case !== 'timerCanceledEventAttributes') {
            break
          }
          const intent = fromTimerCanceled(event.attributes.value, sequence, timersByStartEventId)
          if (intent) {
            commandHistory.push({
              intent,
              metadata: buildCommandMetadata(event, event.attributes.value),
            })
            sequence += 1
          }
          break
        }
        case EventType.SIGNAL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED: {
          if (event.attributes?.case !== 'signalExternalWorkflowExecutionInitiatedEventAttributes') {
            break
          }
          const intent = yield* fromSignalExternalWorkflow(event.attributes.value, sequence, intake)
          if (intent) {
            commandHistory.push({
              intent,
              metadata: buildCommandMetadata(event, event.attributes.value),
            })
            sequence += 1
          }
          break
        }
        case EventType.REQUEST_CANCEL_EXTERNAL_WORKFLOW_EXECUTION_INITIATED: {
          if (event.attributes?.case !== 'requestCancelExternalWorkflowExecutionInitiatedEventAttributes') {
            break
          }
          const intent = fromRequestCancelExternalWorkflow(event.attributes.value, sequence, intake)
          if (intent) {
            commandHistory.push({
              intent,
              metadata: buildCommandMetadata(event, event.attributes.value),
            })
            sequence += 1
          }
          break
        }
        case EventType.WORKFLOW_EXECUTION_SIGNALED: {
          if (event.attributes?.case !== 'workflowExecutionSignaledEventAttributes') {
            break
          }
          const attributes = event.attributes.value as WorkflowExecutionSignaledEventAttributes
          const payloads = yield* decodePayloadArray(intake.dataConverter, attributes.input)
          const workflowTaskCompletedEventId =
            'workflowTaskCompletedEventId' in attributes
              ? normalizeEventId(
                  (attributes as { workflowTaskCompletedEventId?: bigint | number | string | null })
                    .workflowTaskCompletedEventId,
                )
              : null
          signalRecords.push({
            signalName: attributes.signalName ?? 'unknown',
            payloadHash: stableStringify(payloads),
            eventId: normalizeEventId(event.eventId),
            workflowTaskCompletedEventId,
            identity: attributes.identity ?? null,
          })
          break
        }
        case EventType.WORKFLOW_EXECUTION_CONTINUED_AS_NEW: {
          if (event.attributes?.case !== 'workflowExecutionContinuedAsNewEventAttributes') {
            break
          }
          const intent = yield* fromContinueAsNew(event.attributes.value, sequence, intake)
          if (intent) {
            commandHistory.push({
              intent,
              metadata: buildCommandMetadata(event, event.attributes.value),
            })
            sequence += 1
          }
          break
        }
        case EventType.MARKER_RECORDED: {
          if (event.attributes?.case !== 'markerRecordedEventAttributes') {
            break
          }
          if (event.attributes.value.markerName === DETERMINISM_MARKER_NAME) {
            break
          }
          const intent = yield* fromMarkerRecorded(event.attributes.value, sequence, intake)
          if (intent) {
            commandHistory.push({
              intent,
              metadata: buildCommandMetadata(event, event.attributes.value),
            })
            sequence += 1
          }
          break
        }
        case EventType.UPSERT_WORKFLOW_SEARCH_ATTRIBUTES: {
          if (event.attributes?.case !== 'upsertWorkflowSearchAttributesEventAttributes') {
            break
          }
          const intent = yield* fromUpsertSearchAttributes(event.attributes.value, sequence, intake)
          if (intent) {
            commandHistory.push({
              intent,
              metadata: buildCommandMetadata(event, event.attributes.value),
            })
            sequence += 1
          }
          break
        }
        case EventType.WORKFLOW_PROPERTIES_MODIFIED: {
          if (event.attributes?.case !== 'workflowPropertiesModifiedEventAttributes') {
            break
          }
          const intent = yield* fromWorkflowPropertiesModified(event.attributes.value, sequence, intake)
          if (intent) {
            commandHistory.push({
              intent,
              metadata: buildCommandMetadata(event, event.attributes.value),
            })
            sequence += 1
          }
          break
        }
        default:
          break
      }
    }

    const resolvedFailureMetadata = failureMetadata ?? seededState?.failureMetadata
    let determinismState: WorkflowDeterminismState = {
      commandHistory,
      randomValues: seededState?.randomValues ?? [],
      timeValues: seededState?.timeValues ?? [],
      ...(resolvedFailureMetadata ? { failureMetadata: resolvedFailureMetadata } : {}),
      signals: signalRecords,
      queries: queryRecords,
      ...(updates.length > 0 ? { updates } : {}),
    }
    determinismState = mergePendingQueryRequests(determinismState, intake.queries)

    return {
      determinismState,
      lastEventId: options?.historyLastEventId ?? resolveHistoryLastEventId(events),
      hasDeterminismMarker: false,
      ...(replayUpdateInvocations.length > 0 ? { updates: replayUpdateInvocations } : {}),
    }
  })

const fromActivityTaskScheduled = (
  attributes: ActivityTaskScheduledEventAttributes,
  sequence: number,
  intake: ReplayIntake,
): Effect.Effect<ScheduleActivityCommandIntent | undefined, unknown, never> =>
  Effect.gen(function* () {
    const activityType = attributes.activityType?.name
    if (!activityType) {
      return undefined
    }

    const input = yield* decodePayloadArray(intake.dataConverter, attributes.input)

    const eagerAttributes = attributes as unknown as { requestEagerExecution?: boolean }
    const intent: ScheduleActivityCommandIntent = {
      id: `schedule-activity-${sequence}`,
      kind: 'schedule-activity',
      sequence,
      activityType,
      activityId: attributes.activityId || `activity-${sequence}`,
      taskQueue: attributes.taskQueue?.name ?? intake.info.taskQueue,
      input,
      header: attributes.header,
      timeouts: {
        scheduleToCloseTimeoutMs: durationToMillis(attributes.scheduleToCloseTimeout),
        scheduleToStartTimeoutMs: durationToMillis(attributes.scheduleToStartTimeout),
        startToCloseTimeoutMs: durationToMillis(attributes.startToCloseTimeout),
        heartbeatTimeoutMs: durationToMillis(attributes.heartbeatTimeout),
      },
      retry: convertRetryPolicy(attributes.retryPolicy),
      requestEagerExecution: eagerAttributes.requestEagerExecution ?? undefined,
    }

    return intent
  })

const fromTimerStarted = (
  attributes: TimerStartedEventAttributes,
  sequence: number,
): StartTimerCommandIntent | undefined => {
  const timeout = durationToMillis(attributes.startToFireTimeout)
  if (timeout === undefined) {
    return undefined
  }
  const timerId = attributes.timerId || `timer-${sequence}`
  return {
    id: `start-timer-${sequence}`,
    kind: 'start-timer',
    sequence,
    timerId,
    timeoutMs: timeout,
  }
}

const fromStartChildWorkflow = (
  attributes: StartChildWorkflowExecutionInitiatedEventAttributes,
  sequence: number,
  intake: ReplayIntake,
): Effect.Effect<StartChildWorkflowCommandIntent | undefined, unknown, never> =>
  Effect.gen(function* () {
    const workflowType = attributes.workflowType?.name
    if (!workflowType) {
      return undefined
    }

    const input = yield* decodePayloadArray(intake.dataConverter, attributes.input)
    const parentClosePolicy =
      attributes.parentClosePolicy !== undefined && attributes.parentClosePolicy !== ParentClosePolicy.UNSPECIFIED
        ? attributes.parentClosePolicy
        : undefined
    const workflowIdReusePolicy =
      attributes.workflowIdReusePolicy !== undefined &&
      attributes.workflowIdReusePolicy !== WorkflowIdReusePolicy.UNSPECIFIED
        ? attributes.workflowIdReusePolicy
        : undefined

    const intent: StartChildWorkflowCommandIntent = {
      id: `start-child-workflow-${sequence}`,
      kind: 'start-child-workflow',
      sequence,
      workflowType,
      workflowId: attributes.workflowId || `${intake.info.workflowId}-child-${sequence}`,
      namespace: attributes.namespace || intake.info.namespace,
      taskQueue: attributes.taskQueue?.name ?? intake.info.taskQueue,
      input,
      timeouts: {
        workflowExecutionTimeoutMs: durationToMillis(attributes.workflowExecutionTimeout),
        workflowRunTimeoutMs: durationToMillis(attributes.workflowRunTimeout),
        workflowTaskTimeoutMs: durationToMillis(attributes.workflowTaskTimeout),
      },
      parentClosePolicy,
      workflowIdReusePolicy,
      retry: convertRetryPolicy(attributes.retryPolicy),
      cronSchedule: attributes.cronSchedule || undefined,
      header: attributes.header,
      memo: attributes.memo,
      searchAttributes: attributes.searchAttributes,
    }

    return intent
  })

const fromSignalExternalWorkflow = (
  attributes: SignalExternalWorkflowExecutionInitiatedEventAttributes,
  sequence: number,
  intake: ReplayIntake,
): Effect.Effect<SignalExternalWorkflowCommandIntent | undefined, unknown, never> =>
  Effect.gen(function* () {
    if (!attributes.signalName) {
      return undefined
    }
    const input = yield* decodePayloadArray(intake.dataConverter, attributes.input)
    const intent: SignalExternalWorkflowCommandIntent = {
      id: `signal-external-${sequence}`,
      kind: 'signal-external-workflow',
      sequence,
      namespace: attributes.namespace || intake.info.namespace,
      workflowId: attributes.workflowExecution?.workflowId ?? intake.info.workflowId,
      runId: attributes.workflowExecution?.runId || undefined,
      signalName: attributes.signalName,
      input,
      childWorkflowOnly: attributes.childWorkflowOnly ?? false,
      header: attributes.header,
    }

    return intent
  })

const fromContinueAsNew = (
  attributes: WorkflowExecutionContinuedAsNewEventAttributes,
  sequence: number,
  intake: ReplayIntake,
): Effect.Effect<ContinueAsNewWorkflowCommandIntent | undefined, unknown, never> =>
  Effect.gen(function* () {
    const input = yield* decodePayloadArray(intake.dataConverter, attributes.input)
    const extendedAttributes = attributes as unknown as {
      retryPolicy?: RetryPolicy
      cronSchedule?: string
    }
    const intent: ContinueAsNewWorkflowCommandIntent = {
      id: `continue-as-new-${sequence}`,
      kind: 'continue-as-new',
      sequence,
      workflowType: attributes.workflowType?.name ?? intake.info.workflowType,
      taskQueue: attributes.taskQueue?.name ?? intake.info.taskQueue,
      input,
      timeouts: {
        workflowRunTimeoutMs: durationToMillis(attributes.workflowRunTimeout),
        workflowTaskTimeoutMs: durationToMillis(attributes.workflowTaskTimeout),
      },
      backoffStartIntervalMs: durationToMillis(attributes.backoffStartInterval),
      retry: convertRetryPolicy(extendedAttributes.retryPolicy),
      memo: attributes.memo,
      searchAttributes: attributes.searchAttributes,
      header: attributes.header,
      cronSchedule: extendedAttributes.cronSchedule || undefined,
    }

    return intent
  })

const fromActivityTaskCancelRequested = (
  attributes: ActivityTaskCancelRequestedEventAttributes,
  sequence: number,
  scheduledActivities: Map<string, string>,
): RequestCancelActivityCommandIntent | undefined => {
  const scheduledEventId = normalizeBigintIdentifier(attributes.scheduledEventId)
  if (!scheduledEventId) {
    return undefined
  }
  const activityId = scheduledActivities.get(scheduledEventId)
  if (!activityId) {
    return undefined
  }
  return {
    id: `cancel-activity-${sequence}`,
    kind: 'request-cancel-activity',
    sequence,
    activityId,
    scheduledEventId,
  }
}

const fromTimerCanceled = (
  attributes: TimerCanceledEventAttributes,
  sequence: number,
  timersByStartEventId: Map<string, string>,
): CancelTimerCommandIntent | undefined => {
  const startedEventId = normalizeBigintIdentifier(attributes.startedEventId)
  const timerId = attributes.timerId || (startedEventId ? timersByStartEventId.get(startedEventId) : undefined)
  if (!timerId) {
    return undefined
  }
  return {
    id: `cancel-timer-${sequence}`,
    kind: 'cancel-timer',
    sequence,
    timerId,
    startedEventId,
  }
}

const fromRequestCancelExternalWorkflow = (
  attributes: RequestCancelExternalWorkflowExecutionInitiatedEventAttributes,
  sequence: number,
  intake: ReplayIntake,
): RequestCancelExternalWorkflowCommandIntent | undefined => {
  const workflowId = attributes.workflowExecution?.workflowId ?? intake.info.workflowId
  if (!workflowId) {
    return undefined
  }
  return {
    id: `cancel-external-${sequence}`,
    kind: 'request-cancel-external-workflow',
    sequence,
    namespace: attributes.namespace || intake.info.namespace,
    workflowId,
    runId: attributes.workflowExecution?.runId || undefined,
    childWorkflowOnly: attributes.childWorkflowOnly ?? false,
    reason: attributes.reason || undefined,
  }
}

const fromMarkerRecorded = (
  attributes: MarkerRecordedEventAttributes,
  sequence: number,
  intake: ReplayIntake,
): Effect.Effect<RecordMarkerCommandIntent | undefined, unknown, never> =>
  Effect.gen(function* () {
    const markerName = attributes.markerName || 'marker'
    const details = yield* decodeMarkerDetails(intake.dataConverter, attributes.details)
    return {
      id: `record-marker-${sequence}`,
      kind: 'record-marker',
      sequence,
      markerName,
      details,
    }
  })

const fromUpsertSearchAttributes = (
  attributes: UpsertWorkflowSearchAttributesEventAttributes,
  sequence: number,
  intake: ReplayIntake,
): Effect.Effect<UpsertSearchAttributesCommandIntent | undefined, unknown, never> =>
  Effect.gen(function* () {
    const searchAttributes = yield* decodeSearchAttributes(intake.dataConverter, attributes.searchAttributes)
    if (!searchAttributes) {
      return undefined
    }
    return {
      id: `upsert-search-attributes-${sequence}`,
      kind: 'upsert-search-attributes',
      sequence,
      searchAttributes,
    }
  })

const fromWorkflowPropertiesModified = (
  attributes: WorkflowPropertiesModifiedEventAttributes,
  sequence: number,
  intake: ReplayIntake,
): Effect.Effect<ModifyWorkflowPropertiesCommandIntent | undefined, unknown, never> =>
  Effect.gen(function* () {
    const memo = yield* decodeMemo(intake.dataConverter, attributes.upsertedMemo)
    return {
      id: `modify-workflow-properties-${sequence}`,
      kind: 'modify-workflow-properties',
      sequence,
      memo,
    }
  })

const collectWorkflowUpdateEntries = (events: HistoryEvent[]): WorkflowUpdateDeterminismEntry[] => {
  const updates: WorkflowUpdateDeterminismEntry[] = []

  for (const event of events) {
    if (!event.attributes) {
      continue
    }
    const historyEventId = normalizeEventId(event.eventId) ?? undefined

    switch (event.eventType) {
      case EventType.WORKFLOW_EXECUTION_UPDATE_ADMITTED: {
        if (event.attributes.case !== 'workflowExecutionUpdateAdmittedEventAttributes') {
          break
        }
        const attrs = event.attributes.value as WorkflowExecutionUpdateAdmittedEventAttributes
        const updateId = normalizeUpdateId(attrs.request?.meta?.updateId)
        if (!updateId) {
          break
        }
        updates.push({
          updateId,
          stage: 'admitted',
          handlerName: normalizeOptionalNonEmptyString(attrs.request?.input?.name),
          identity: normalizeOptionalNonEmptyString(attrs.request?.meta?.identity),
          historyEventId,
        })
        break
      }
      case EventType.WORKFLOW_EXECUTION_UPDATE_ACCEPTED: {
        if (event.attributes.case !== 'workflowExecutionUpdateAcceptedEventAttributes') {
          break
        }
        const attrs = event.attributes.value as WorkflowExecutionUpdateAcceptedEventAttributes
        const updateId = normalizeUpdateId(attrs.acceptedRequest?.meta?.updateId)
        if (!updateId) {
          break
        }
        updates.push({
          updateId,
          stage: 'accepted',
          handlerName: normalizeOptionalNonEmptyString(attrs.acceptedRequest?.input?.name),
          identity: normalizeOptionalNonEmptyString(attrs.acceptedRequest?.meta?.identity),
          messageId: normalizeOptionalNonEmptyString(attrs.acceptedRequestMessageId),
          sequencingEventId: normalizeBigintIdentifier(attrs.acceptedRequestSequencingEventId),
          historyEventId,
        })
        break
      }
      case EventType.WORKFLOW_EXECUTION_UPDATE_REJECTED: {
        if (event.attributes.case !== 'workflowExecutionUpdateRejectedEventAttributes') {
          break
        }
        const attrs = event.attributes.value as WorkflowExecutionUpdateRejectedEventAttributes
        const updateId = normalizeUpdateId(attrs.rejectedRequest?.meta?.updateId)
        if (!updateId) {
          break
        }
        updates.push({
          updateId,
          stage: 'rejected',
          handlerName: normalizeOptionalNonEmptyString(attrs.rejectedRequest?.input?.name),
          identity: normalizeOptionalNonEmptyString(attrs.rejectedRequest?.meta?.identity),
          messageId: normalizeOptionalNonEmptyString(attrs.rejectedRequestMessageId),
          sequencingEventId: normalizeBigintIdentifier(attrs.rejectedRequestSequencingEventId),
          failureMessage: normalizeOptionalNonEmptyString(attrs.failure?.message),
          historyEventId,
        })
        break
      }
      case EventType.WORKFLOW_EXECUTION_UPDATE_COMPLETED: {
        if (event.attributes.case !== 'workflowExecutionUpdateCompletedEventAttributes') {
          break
        }
        const attrs = event.attributes.value as WorkflowExecutionUpdateCompletedEventAttributes
        const updateId = normalizeUpdateId(attrs.meta?.updateId)
        if (!updateId) {
          break
        }
        updates.push({
          updateId,
          stage: 'completed',
          identity: normalizeOptionalNonEmptyString(attrs.meta?.identity),
          acceptedEventId: normalizeBigintIdentifier(attrs.acceptedEventId),
          outcome: resolveOutcomeStatus(attrs.outcome),
          historyEventId,
        })
        break
      }
      default:
        break
    }
  }

  return updates
}

const collectWorkflowUpdateInvocations = async (
  events: HistoryEvent[],
  dataConverter: DataConverter,
): Promise<WorkflowUpdateInvocation[]> => {
  const invocations: WorkflowUpdateInvocation[] = []

  for (const event of events) {
    if (event.eventType === EventType.WORKFLOW_EXECUTION_UPDATE_ACCEPTED) {
      if (event.attributes.case !== 'workflowExecutionUpdateAcceptedEventAttributes') {
        continue
      }
      const attrs = event.attributes.value as WorkflowExecutionUpdateAcceptedEventAttributes
      const invocation = await buildUpdateInvocationFromRequest({
        request: attrs.acceptedRequest,
        protocolInstanceId: attrs.protocolInstanceId,
        requestMessageId: attrs.acceptedRequestMessageId,
        sequencingEventId: attrs.acceptedRequestSequencingEventId,
        fallbackEventId: event.eventId,
        dataConverter,
      })
      if (invocation) {
        invocations.push(invocation)
      }
      continue
    }

    if (event.eventType === EventType.WORKFLOW_EXECUTION_UPDATE_REJECTED) {
      if (event.attributes.case !== 'workflowExecutionUpdateRejectedEventAttributes') {
        continue
      }
      const attrs = event.attributes.value as WorkflowExecutionUpdateRejectedEventAttributes
      const invocation = await buildUpdateInvocationFromRequest({
        request: attrs.rejectedRequest,
        protocolInstanceId: attrs.protocolInstanceId,
        requestMessageId: attrs.rejectedRequestMessageId,
        sequencingEventId: attrs.rejectedRequestSequencingEventId,
        fallbackEventId: event.eventId,
        dataConverter,
      })
      if (invocation) {
        invocations.push(invocation)
      }
      continue
    }

    if (event.eventType === EventType.WORKFLOW_EXECUTION_UPDATE_ADMITTED) {
      if (event.attributes.case !== 'workflowExecutionUpdateAdmittedEventAttributes') {
        continue
      }
      const attrs = event.attributes.value as WorkflowExecutionUpdateAdmittedEventAttributes
      const invocation = await buildUpdateInvocationFromRequest({
        request: attrs.request,
        protocolInstanceId: 'history-admitted',
        requestMessageId: `history-${event.eventId ?? 'update-admitted'}`,
        sequencingEventId: event.eventId ? BigInt(event.eventId) : undefined,
        fallbackEventId: event.eventId,
        dataConverter,
      })
      if (invocation) {
        invocations.push(invocation)
      }
    }
  }

  return invocations
}

const buildUpdateInvocationFromRequest = async (input: {
  request:
    | WorkflowExecutionUpdateAdmittedEventAttributes['request']
    | WorkflowExecutionUpdateAcceptedEventAttributes['acceptedRequest']
  protocolInstanceId?: string
  requestMessageId?: string
  sequencingEventId?: bigint
  fallbackEventId?: string | number | bigint | null
  dataConverter: DataConverter
}): Promise<WorkflowUpdateInvocation | undefined> => {
  const req = input.request
  const updateId = normalizeUpdateId(req?.meta?.updateId)
  const updateName = req?.input?.name?.trim()
  if (!updateId || !updateName) {
    return undefined
  }
  const values =
    (await decodePayloadsToValues(input.dataConverter, req?.input?.args?.payloads ?? []))?.map((value) => value) ?? []
  const payload = normalizeUpdateInvocationPayload(values)
  const sequencing =
    input.sequencingEventId !== undefined
      ? input.sequencingEventId.toString()
      : input.fallbackEventId !== undefined && input.fallbackEventId !== null
        ? String(input.fallbackEventId)
        : undefined

  return {
    protocolInstanceId: input.protocolInstanceId ?? 'history-replay',
    requestMessageId: input.requestMessageId ?? updateId,
    updateId,
    name: updateName,
    payload,
    identity: req?.meta?.identity,
    sequencingEventId: sequencing,
  }
}

const normalizeUpdateInvocationPayload = (values: unknown[]): unknown => {
  if (!values || values.length === 0) {
    return undefined
  }
  if (values.length === 1) {
    return values[0]
  }
  return values
}

const decodePayloadArray = (
  converter: DataConverter,
  payloads: Payloads | undefined,
): Effect.Effect<unknown[], unknown, never> =>
  Effect.tryPromise(async () => await decodePayloadsToValues(converter, payloads?.payloads ?? []))

const decodeMarkerDetails = (
  converter: DataConverter,
  details: Record<string, Payloads> | undefined,
): Effect.Effect<Record<string, unknown> | undefined, unknown, never> =>
  Effect.tryPromise(async () => {
    if (!details || Object.keys(details).length === 0) {
      return undefined
    }
    const decoded: Record<string, unknown> = {}
    for (const [key, payloads] of Object.entries(details)) {
      const values = await decodePayloadsToValues(converter, payloads?.payloads ?? [])
      if (values.length === 0) {
        continue
      }
      decoded[key] = values.length === 1 ? values[0] : values
    }
    return Object.keys(decoded).length > 0 ? decoded : undefined
  })

const decodeSearchAttributes = (
  converter: DataConverter,
  input: SearchAttributes | undefined,
): Effect.Effect<Record<string, unknown> | undefined, unknown, never> =>
  Effect.tryPromise(async () => {
    const fields = input?.indexedFields
    if (!fields || Object.keys(fields).length === 0) {
      return undefined
    }
    const decoded: Record<string, unknown> = {}
    for (const [key, payload] of Object.entries(fields)) {
      const values = await decodePayloadsToValues(converter, payload ? [payload] : [])
      if (values.length === 0) {
        continue
      }
      decoded[key] = values.length === 1 ? values[0] : values
    }
    return decoded
  })

const decodeMemo = (
  converter: DataConverter,
  memo: Memo | undefined,
): Effect.Effect<Record<string, unknown>, unknown, never> =>
  Effect.tryPromise(async () => {
    const decoded: Record<string, unknown> = {}
    const fields = memo?.fields ?? {}
    for (const [key, payload] of Object.entries(fields)) {
      const values = await decodePayloadsToValues(converter, payload ? [payload] : [])
      if (values.length === 0) {
        decoded[key] = undefined
      } else {
        decoded[key] = values.length === 1 ? values[0] : values
      }
    }
    return decoded
  })

const convertRetryPolicy = (policy: RetryPolicy | undefined): WorkflowRetryPolicyInput | undefined => {
  if (!policy) {
    return undefined
  }

  const initialIntervalMs = durationToMillis(policy.initialInterval)
  const maximumIntervalMs = durationToMillis(policy.maximumInterval)
  const backoffCoefficient = policy.backoffCoefficient !== 0 ? policy.backoffCoefficient : undefined
  const maximumAttempts = policy.maximumAttempts > 0 ? policy.maximumAttempts : undefined
  const nonRetryable = policy.nonRetryableErrorTypes.length > 0 ? [...policy.nonRetryableErrorTypes] : undefined

  if (
    initialIntervalMs === undefined &&
    maximumIntervalMs === undefined &&
    backoffCoefficient === undefined &&
    maximumAttempts === undefined &&
    (nonRetryable === undefined || nonRetryable.length === 0)
  ) {
    return undefined
  }

  return {
    ...(initialIntervalMs !== undefined ? { initialIntervalMs } : {}),
    ...(backoffCoefficient !== undefined ? { backoffCoefficient } : {}),
    ...(maximumIntervalMs !== undefined ? { maximumIntervalMs } : {}),
    ...(maximumAttempts !== undefined ? { maximumAttempts } : {}),
    ...(nonRetryable !== undefined ? { nonRetryableErrorTypes: nonRetryable } : {}),
  }
}

const normalizeUpdateId = (value: string | undefined | null): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const normalizeOptionalNonEmptyString = (value: string | undefined | null): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const normalizeBigintIdentifier = (value: bigint | number | string | undefined | null): string | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString()
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  return undefined
}

const resolveOutcomeStatus = (outcome?: Outcome | null): 'success' | 'failure' | undefined => {
  const caseName = outcome?.value?.case
  if (caseName === 'success') {
    return 'success'
  }
  if (caseName === 'failure') {
    return 'failure'
  }
  return undefined
}

const applyDeterminismDelta = (
  state: WorkflowDeterminismState,
  delta: DeterminismStateDelta,
): WorkflowDeterminismState => ({
  ...state,
  commandHistory: [...state.commandHistory, ...(delta.commandHistory ?? [])],
  randomValues: [...state.randomValues, ...(delta.randomValues ?? [])],
  timeValues: [...state.timeValues, ...(delta.timeValues ?? [])],
  signals: [...state.signals, ...(delta.signals ?? [])],
  queries: [...state.queries, ...(delta.queries ?? [])],
  ...(delta.updates
    ? { updates: [...(state.updates ?? []), ...(delta.updates ?? [])] }
    : state.updates
      ? { updates: [...state.updates] }
      : {}),
  ...(delta.logCount !== undefined ? { logCount: delta.logCount } : {}),
  ...(delta.failureMetadata ? { failureMetadata: delta.failureMetadata } : {}),
})

const applyDeterminismMarker = (
  state: WorkflowDeterminismState | undefined,
  marker: DeterminismMarkerEnvelope,
): WorkflowDeterminismState | undefined => {
  if (marker.schemaVersion === 1) {
    return marker.determinismState
  }
  const base = marker.determinismState ?? state
  if (!base) {
    return undefined
  }
  if (!marker.determinismDelta) {
    return base
  }
  return applyDeterminismDelta(base, marker.determinismDelta)
}

const sanitizeDeterminismMarkerEnvelope = (input: Record<string, unknown>): DeterminismMarkerEnvelope => {
  const schemaVersion = input.schemaVersion
  if (
    schemaVersion !== DETERMINISM_MARKER_SCHEMA_VERSION_V1 &&
    schemaVersion !== DETERMINISM_MARKER_SCHEMA_VERSION_V2
  ) {
    throw new Error(`Unsupported determinism marker schema version: ${String(schemaVersion)}`)
  }

  const workflow = sanitizeWorkflowInfo(input.workflow)
  const lastEventId = normalizeEventId(input.lastEventId)
  const recordedAt = sanitizeRecordedAt(input.recordedAtIso)

  if (schemaVersion === DETERMINISM_MARKER_SCHEMA_VERSION_V1) {
    const determinismState = sanitizeDeterminismState(input.determinismState)
    return {
      schemaVersion: DETERMINISM_MARKER_SCHEMA_VERSION_V1,
      workflow,
      determinismState,
      lastEventId,
      recordedAtIso: recordedAt,
    }
  }

  const determinismState =
    input.determinismState !== undefined ? sanitizeDeterminismState(input.determinismState) : undefined
  const determinismDelta =
    input.determinismDelta !== undefined ? sanitizeDeterminismDelta(input.determinismDelta) : undefined
  if (!determinismState && !determinismDelta) {
    throw new Error('Determinism marker missing determinism state or delta')
  }

  return {
    schemaVersion: DETERMINISM_MARKER_SCHEMA_VERSION_V2,
    workflow,
    ...(determinismState ? { determinismState } : {}),
    ...(determinismDelta ? { determinismDelta } : {}),
    lastEventId,
    recordedAtIso: recordedAt,
  }
}

const sanitizeWorkflowInfo = (value: unknown): WorkflowInfo => {
  if (!isRecord(value)) {
    throw new Error('Determinism marker missing workflow metadata')
  }

  return {
    namespace: coerceString(value.namespace, 'workflow.namespace'),
    taskQueue: coerceString(value.taskQueue, 'workflow.taskQueue'),
    workflowId: coerceString(value.workflowId, 'workflow.workflowId'),
    runId: coerceString(value.runId, 'workflow.runId'),
    workflowType: coerceString(value.workflowType, 'workflow.workflowType'),
  }
}

const sanitizeDeterminismState = (value: unknown): WorkflowDeterminismState => {
  if (!isRecord(value)) {
    throw new Error('Determinism marker missing determinism state')
  }

  const commandHistoryRaw = value.commandHistory
  const randomValuesRaw = value.randomValues
  const timeValuesRaw = value.timeValues
  const logCountRaw = value.logCount
  const signalsRaw = Array.isArray(value.signals) ? value.signals : []
  const queriesRaw = Array.isArray(value.queries) ? value.queries : []
  const updatesRaw = value.updates

  if (!Array.isArray(commandHistoryRaw) || !Array.isArray(randomValuesRaw) || !Array.isArray(timeValuesRaw)) {
    throw new Error('Determinism marker contained invalid determinism state shape')
  }

  const commandHistory = commandHistoryRaw.map((entry, index) => {
    if (!isRecord(entry) || entry.intent === undefined) {
      throw new Error(`Determinism marker command history entry ${index} is invalid`)
    }
    const metadata = sanitizeCommandMetadata(entry.metadata, index)
    return {
      intent: entry.intent as WorkflowDeterminismState['commandHistory'][number]['intent'],
      ...(metadata ? { metadata } : {}),
    }
  })

  const randomValues = randomValuesRaw.map((val, index) => coerceNumber(val, `determinism.randomValues[${index}]`))
  const timeValues = timeValuesRaw.map((val, index) => coerceNumber(val, `determinism.timeValues[${index}]`))
  const logCount = coerceOptionalNumber(logCountRaw, 'determinism.logCount')
  const failureMetadata = sanitizeFailureMetadata(value.failureMetadata)
  const signals = signalsRaw.map((record, index) => sanitizeSignalRecord(record, index))
  const queries = queriesRaw.map((record, index) => sanitizeQueryRecord(record, index))
  const updates = sanitizeDeterminismUpdates(updatesRaw)

  return {
    commandHistory,
    randomValues,
    timeValues,
    ...(logCount !== undefined ? { logCount } : {}),
    ...(failureMetadata ? { failureMetadata } : {}),
    signals,
    queries,
    ...(updates ? { updates } : {}),
  }
}

const sanitizeDeterminismDelta = (value: unknown): DeterminismStateDelta => {
  if (!isRecord(value)) {
    throw new Error('Determinism marker contained invalid determinism delta')
  }

  const commandHistoryRaw = value.commandHistory ?? []
  const randomValuesRaw = value.randomValues ?? []
  const timeValuesRaw = value.timeValues ?? []
  const signalsRaw = value.signals ?? []
  const queriesRaw = value.queries ?? []

  if (
    !Array.isArray(commandHistoryRaw) ||
    !Array.isArray(randomValuesRaw) ||
    !Array.isArray(timeValuesRaw) ||
    !Array.isArray(signalsRaw) ||
    !Array.isArray(queriesRaw)
  ) {
    throw new Error('Determinism marker contained invalid determinism delta shape')
  }

  return sanitizeDeterminismState({
    commandHistory: commandHistoryRaw,
    randomValues: randomValuesRaw,
    timeValues: timeValuesRaw,
    signals: signalsRaw,
    queries: queriesRaw,
    ...(value.updates !== undefined ? { updates: value.updates } : {}),
    ...(value.logCount !== undefined ? { logCount: value.logCount } : {}),
    ...(value.failureMetadata !== undefined ? { failureMetadata: value.failureMetadata } : {}),
  })
}

const sanitizeCommandMetadata = (value: unknown, index: number): WorkflowCommandHistoryEntryMetadata | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (!isRecord(value)) {
    throw new Error(`Determinism marker command history entry ${index} metadata is invalid`)
  }
  const eventId = normalizeOptionalEventId(value.eventId, `determinism.commandHistory[${index}].metadata.eventId`)
  const workflowTaskCompletedEventId = normalizeOptionalEventId(
    value.workflowTaskCompletedEventId,
    `determinism.commandHistory[${index}].metadata.workflowTaskCompletedEventId`,
  )
  const eventTypeValue = value.eventType
  const eventType =
    typeof eventTypeValue === 'number' && Number.isFinite(eventTypeValue) ? (eventTypeValue as EventType) : undefined
  const hasMetadata = eventId || workflowTaskCompletedEventId || eventType !== undefined
  if (!hasMetadata) {
    return undefined
  }
  return {
    ...(eventId ? { eventId } : {}),
    ...(workflowTaskCompletedEventId ? { workflowTaskCompletedEventId } : {}),
    ...(eventType !== undefined ? { eventType } : {}),
  }
}

const sanitizeFailureMetadata = (value: unknown): WorkflowDeterminismFailureMetadata | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (!isRecord(value)) {
    throw new Error('Determinism marker contained invalid failure metadata')
  }
  const eventId = normalizeOptionalEventId(value.eventId, 'determinism.failureMetadata.eventId')
  const failureType = coerceOptionalString(value.failureType, 'determinism.failureMetadata.failureType')
  const failureMessage = coerceOptionalString(value.failureMessage, 'determinism.failureMetadata.failureMessage')
  const workflowEventType =
    typeof value.eventType === 'number' && Number.isFinite(value.eventType) ? (value.eventType as EventType) : undefined
  const retryState = coerceOptionalNumber(value.retryState, 'determinism.failureMetadata.retryState')
  if (!eventId && !failureType && !failureMessage && workflowEventType === undefined && retryState === undefined) {
    return undefined
  }
  return {
    ...(eventId ? { eventId } : {}),
    ...(workflowEventType !== undefined ? { eventType: workflowEventType } : {}),
    ...(failureType ? { failureType } : {}),
    ...(failureMessage ? { failureMessage } : {}),
    ...(retryState !== undefined ? { retryState } : {}),
  }
}

const sanitizeDeterminismUpdates = (value: unknown): WorkflowUpdateDeterminismEntry[] | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (!Array.isArray(value)) {
    throw new Error('Determinism marker contained invalid updates list')
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Determinism marker update entry ${index} is invalid`)
    }
    const updateId = coerceString(entry.updateId, `determinism.updates[${index}].updateId`)
    const stage = sanitizeUpdateStage(entry.stage, index)
    const handlerName = coerceOptionalTrimmedString(entry.handlerName, `determinism.updates[${index}].handlerName`)
    const identity = coerceOptionalTrimmedString(entry.identity, `determinism.updates[${index}].identity`)
    const sequencingEventId = coerceOptionalTrimmedString(
      entry.sequencingEventId,
      `determinism.updates[${index}].sequencingEventId`,
    )
    const messageId = coerceOptionalTrimmedString(entry.messageId, `determinism.updates[${index}].messageId`)
    const acceptedEventId = coerceOptionalTrimmedString(
      entry.acceptedEventId,
      `determinism.updates[${index}].acceptedEventId`,
    )
    const outcome = sanitizeUpdateOutcome(entry.outcome, index)
    const failureMessage = coerceOptionalTrimmedString(
      entry.failureMessage,
      `determinism.updates[${index}].failureMessage`,
    )
    const historyEventId = coerceOptionalTrimmedString(
      entry.historyEventId,
      `determinism.updates[${index}].historyEventId`,
    )

    return {
      updateId,
      stage,
      ...(handlerName ? { handlerName } : {}),
      ...(identity ? { identity } : {}),
      ...(sequencingEventId ? { sequencingEventId } : {}),
      ...(messageId ? { messageId } : {}),
      ...(acceptedEventId ? { acceptedEventId } : {}),
      ...(outcome ? { outcome } : {}),
      ...(failureMessage ? { failureMessage } : {}),
      ...(historyEventId ? { historyEventId } : {}),
    }
  })
}

const sanitizeSignalRecord = (value: unknown, index: number): WorkflowDeterminismSignalRecord => {
  if (!isRecord(value)) {
    throw new Error(`Determinism marker contained invalid signal entry at index ${index}`)
  }
  const signalName = coerceString(value.signalName, `determinism.signals[${index}].signalName`)
  const payloadHash = coerceString(value.payloadHash, `determinism.signals[${index}].payloadHash`)
  const handlerName = coerceOptionalString(value.handlerName, `determinism.signals[${index}].handlerName`)
  const eventId = normalizeOptionalEventId(value.eventId, `determinism.signals[${index}].eventId`)
  const workflowTaskCompletedEventId = normalizeOptionalEventId(
    value.workflowTaskCompletedEventId,
    `determinism.signals[${index}].workflowTaskCompletedEventId`,
  )
  const identity = coerceOptionalString(value.identity, `determinism.signals[${index}].identity`)
  return {
    signalName,
    payloadHash,
    ...(handlerName ? { handlerName } : {}),
    ...(eventId ? { eventId } : {}),
    ...(workflowTaskCompletedEventId ? { workflowTaskCompletedEventId } : {}),
    ...(identity ? { identity } : {}),
  }
}

const sanitizeQueryRecord = (value: unknown, index: number): WorkflowDeterminismQueryRecord => {
  if (!isRecord(value)) {
    throw new Error(`Determinism marker contained invalid query entry at index ${index}`)
  }
  const queryName = coerceString(value.queryName, `determinism.queries[${index}].queryName`)
  const requestHash = coerceString(value.requestHash, `determinism.queries[${index}].requestHash`)
  const handlerName = coerceOptionalString(value.handlerName, `determinism.queries[${index}].handlerName`)
  const identity = coerceOptionalString(value.identity, `determinism.queries[${index}].identity`)
  const queryId = coerceOptionalString(value.queryId, `determinism.queries[${index}].queryId`)
  const resultHash = coerceOptionalString(value.resultHash, `determinism.queries[${index}].resultHash`)
  const failureHash = coerceOptionalString(value.failureHash, `determinism.queries[${index}].failureHash`)
  return {
    queryName,
    requestHash,
    ...(handlerName ? { handlerName } : {}),
    ...(identity ? { identity } : {}),
    ...(queryId ? { queryId } : {}),
    ...(resultHash ? { resultHash } : {}),
    ...(failureHash ? { failureHash } : {}),
  }
}

const sanitizeRecordedAt = (value: unknown): string => {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  throw new Error('Determinism marker missing recordedAt timestamp')
}

const normalizeEventId = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString()
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  throw new Error(`Determinism marker contained invalid lastEventId: ${String(value)}`)
}

const coerceString = (value: unknown, label: string): string => {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  throw new Error(`Determinism marker missing ${label}`)
}

const coerceOptionalString = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`Determinism marker contained invalid ${label}`)
  }
  return value.length > 0 ? value : undefined
}

const coerceOptionalTrimmedString = (value: unknown, label: string): string | undefined => {
  const raw = coerceOptionalString(value, label)
  if (raw === undefined) {
    return undefined
  }
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const coerceNumber = (value: unknown, label: string): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'bigint') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
      return numeric
    }
  }
  throw new Error(`Determinism marker contained non-finite ${label}`)
}

const coerceOptionalNumber = (value: unknown, label: string): number | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  return coerceNumber(value, label)
}

const normalizeOptionalEventId = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  try {
    return normalizeEventId(value) ?? undefined
  } catch {
    throw new Error(`Determinism marker contained invalid ${label}`)
  }
}

const sanitizeUpdateStage = (value: unknown, index: number): WorkflowUpdateDeterminismStage => {
  if (value === 'admitted' || value === 'accepted' || value === 'rejected' || value === 'completed') {
    return value
  }
  throw new Error(`Determinism marker update entry ${index} contained invalid stage`)
}

const sanitizeUpdateOutcome = (value: unknown, index: number): 'success' | 'failure' | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (value === 'success' || value === 'failure') {
    return value
  }
  throw new Error(`Determinism marker update entry ${index} contained invalid outcome`)
}

const valuesEqual = (expected: number | undefined, actual: number | undefined): boolean => {
  if (expected === undefined && actual === undefined) {
    return true
  }
  if (expected === undefined || actual === undefined) {
    return false
  }
  return Object.is(expected, actual)
}

const updatesEqual = (expected?: WorkflowUpdateDeterminismEntry, actual?: WorkflowUpdateDeterminismEntry): boolean => {
  if (!expected && !actual) {
    return true
  }
  if (!expected || !actual) {
    return false
  }
  return (
    expected.updateId === actual.updateId &&
    expected.stage === actual.stage &&
    expected.handlerName === actual.handlerName &&
    expected.identity === actual.identity &&
    expected.sequencingEventId === actual.sequencingEventId &&
    expected.messageId === actual.messageId &&
    expected.outcome === actual.outcome &&
    expected.failureMessage === actual.failureMessage
  )
}

const recordsMatch = <T>(expected: T | undefined, actual: T | undefined): boolean => {
  if (expected === undefined && actual === undefined) {
    return true
  }
  if (expected === undefined || actual === undefined) {
    return false
  }
  return stableStringify(expected) === stableStringify(actual)
}

const mergePendingQueryRequests = (
  state: WorkflowDeterminismState,
  requests: readonly WorkflowQueryRequest[] | undefined,
): WorkflowDeterminismState => {
  if (!requests || requests.length === 0) {
    return state
  }
  const nextQueries = state.queries ? [...state.queries] : []
  for (const request of requests) {
    nextQueries.push({
      queryName: request.name,
      requestHash: stableStringify(request.args ?? []),
      ...(request.metadata?.identity ? { identity: request.metadata.identity } : {}),
      ...(request.id ? { queryId: request.id } : {}),
    })
  }
  return {
    ...state,
    queries: nextQueries,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
