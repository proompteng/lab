import { create } from '@bufbuild/protobuf'
import { Effect } from 'effect'

import { durationToMillis } from '../common/duration'
import { type DataConverter, decodePayloadsToValues, encodeValuesToPayloads } from '../common/payloads'
import { type Payloads, PayloadsSchema, type RetryPolicy } from '../proto/temporal/api/common/v1/message_pb'
import { EventType } from '../proto/temporal/api/enums/v1/event_type_pb'
import { ParentClosePolicy, WorkflowIdReusePolicy } from '../proto/temporal/api/enums/v1/workflow_pb'
import type {
  ActivityTaskScheduledEventAttributes,
  HistoryEvent,
  SignalExternalWorkflowExecutionInitiatedEventAttributes,
  StartChildWorkflowExecutionInitiatedEventAttributes,
  TimerStartedEventAttributes,
  WorkflowExecutionContinuedAsNewEventAttributes,
} from '../proto/temporal/api/history/v1/message_pb'
import type {
  ContinueAsNewWorkflowCommandIntent,
  ScheduleActivityCommandIntent,
  SignalExternalWorkflowCommandIntent,
  StartChildWorkflowCommandIntent,
  StartTimerCommandIntent,
  WorkflowCommandIntent,
} from './commands'
import type { WorkflowInfo } from './context'
import type { WorkflowCommandHistoryEntry, WorkflowDeterminismState, WorkflowRetryPolicyInput } from './determinism'
import { intentsEqual } from './determinism'

export interface ReplayIntake {
  readonly info: WorkflowInfo
  readonly history: HistoryEvent[]
  readonly dataConverter: DataConverter
}

export interface ReplayResult {
  readonly determinismState: WorkflowDeterminismState
  readonly lastEventId: string | null
  readonly hasDeterminismMarker: boolean
}

export interface DeterminismMarkerInput {
  readonly info: WorkflowInfo
  readonly determinismState: WorkflowDeterminismState
  readonly lastEventId: string | null
  readonly recordedAt?: Date
}

export interface DeterminismMarkerEnvelope {
  readonly schemaVersion: number
  readonly workflow: WorkflowInfo
  readonly determinismState: WorkflowDeterminismState
  readonly lastEventId: string | null
  readonly recordedAtIso: string
}

export interface DeterminismDiffResult {
  readonly mismatches: DeterminismMismatch[]
}

export interface DeterminismMismatchCommand {
  readonly kind: 'command'
  readonly index: number
  readonly expected?: WorkflowCommandIntent
  readonly actual?: WorkflowCommandIntent
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

export type DeterminismMismatch = DeterminismMismatchCommand | DeterminismMismatchRandom | DeterminismMismatchTime

export const DETERMINISM_MARKER_NAME = 'temporal-bun-sdk/determinism'

const DETERMINISM_MARKER_SCHEMA_VERSION = 1
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
    const envelope: DeterminismMarkerEnvelope = {
      schemaVersion: DETERMINISM_MARKER_SCHEMA_VERSION,
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
    const events = intake.history ?? []
    let markerSnapshot: DeterminismMarkerEnvelope | undefined

    for (const event of events) {
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
        markerSnapshot = decoded
      }
    }

    if (markerSnapshot) {
      const latestEventId = resolveHistoryLastEventId(events) ?? markerSnapshot.lastEventId ?? null
      return {
        determinismState: markerSnapshot.determinismState,
        lastEventId: latestEventId,
        hasDeterminismMarker: true,
      }
    }

    return yield* reconstructDeterminismState(events, intake)
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
      const expectedIntent = expected.commandHistory[index]?.intent
      const actualIntent = actual.commandHistory[index]?.intent
      if (!expectedIntent || !actualIntent) {
        if (expectedIntent !== actualIntent) {
          mismatches.push({
            kind: 'command',
            index,
            expected: expectedIntent,
            actual: actualIntent,
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
  commandHistory: state.commandHistory.map((entry) => ({ intent: entry.intent })),
  randomValues: [...state.randomValues],
  timeValues: [...state.timeValues],
})

const reconstructDeterminismState = (
  events: HistoryEvent[],
  intake: ReplayIntake,
): Effect.Effect<ReplayResult, unknown, never> =>
  Effect.gen(function* () {
    let sequence = 0
    const commandHistory: WorkflowCommandHistoryEntry[] = []

    for (const event of events) {
      switch (event.eventType) {
        case EventType.ACTIVITY_TASK_SCHEDULED: {
          if (event.attributes?.case !== 'activityTaskScheduledEventAttributes') {
            break
          }
          const intent = yield* fromActivityTaskScheduled(event.attributes.value, sequence, intake)
          if (intent) {
            commandHistory.push({ intent })
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
            commandHistory.push({ intent })
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
            commandHistory.push({ intent })
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
            commandHistory.push({ intent })
            sequence += 1
          }
          break
        }
        case EventType.WORKFLOW_EXECUTION_CONTINUED_AS_NEW: {
          if (event.attributes?.case !== 'workflowExecutionContinuedAsNewEventAttributes') {
            break
          }
          const intent = yield* fromContinueAsNew(event.attributes.value, sequence, intake)
          if (intent) {
            commandHistory.push({ intent })
            sequence += 1
          }
          break
        }
        default:
          break
      }
    }

    return {
      determinismState: {
        commandHistory,
        randomValues: [],
        timeValues: [],
      },
      lastEventId: resolveHistoryLastEventId(events),
      hasDeterminismMarker: false,
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

const decodePayloadArray = (
  converter: DataConverter,
  payloads: Payloads | undefined,
): Effect.Effect<unknown[], unknown, never> =>
  Effect.tryPromise(async () => await decodePayloadsToValues(converter, payloads?.payloads ?? []))

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

const sanitizeDeterminismMarkerEnvelope = (input: Record<string, unknown>): DeterminismMarkerEnvelope => {
  const schemaVersion = input.schemaVersion
  if (schemaVersion !== DETERMINISM_MARKER_SCHEMA_VERSION) {
    throw new Error(`Unsupported determinism marker schema version: ${String(schemaVersion)}`)
  }

  const workflow = sanitizeWorkflowInfo(input.workflow)
  const determinismState = sanitizeDeterminismState(input.determinismState)
  const lastEventId = normalizeEventId(input.lastEventId)
  const recordedAt = sanitizeRecordedAt(input.recordedAtIso)

  return {
    schemaVersion: DETERMINISM_MARKER_SCHEMA_VERSION,
    workflow,
    determinismState,
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

  if (!Array.isArray(commandHistoryRaw) || !Array.isArray(randomValuesRaw) || !Array.isArray(timeValuesRaw)) {
    throw new Error('Determinism marker contained invalid determinism state shape')
  }

  const commandHistory = commandHistoryRaw.map((entry, index) => {
    if (!isRecord(entry) || entry.intent === undefined) {
      throw new Error(`Determinism marker command history entry ${index} is invalid`)
    }
    return {
      intent: entry.intent as WorkflowDeterminismState['commandHistory'][number]['intent'],
    }
  })

  const randomValues = randomValuesRaw.map((val, index) => coerceNumber(val, `determinism.randomValues[${index}]`))
  const timeValues = timeValuesRaw.map((val, index) => coerceNumber(val, `determinism.timeValues[${index}]`))

  return {
    commandHistory,
    randomValues,
    timeValues,
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

const valuesEqual = (expected: number | undefined, actual: number | undefined): boolean => {
  if (expected === undefined && actual === undefined) {
    return true
  }
  if (expected === undefined || actual === undefined) {
    return false
  }
  return Object.is(expected, actual)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
