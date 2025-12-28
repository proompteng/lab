import type { EventType } from '../proto/temporal/api/enums/v1/event_type_pb'
import { WorkflowIdReusePolicy } from '../proto/temporal/api/enums/v1/workflow_pb'
import type { WorkflowCommandIntent } from './commands'
import { WorkflowNondeterminismError, WorkflowQueryViolationError } from './errors'

export interface WorkflowRetryPolicyInput {
  readonly initialIntervalMs?: number
  readonly backoffCoefficient?: number
  readonly maximumIntervalMs?: number
  readonly maximumAttempts?: number
  readonly nonRetryableErrorTypes?: string[]
}

export interface WorkflowCommandHistoryEntryMetadata {
  readonly eventId?: string | null
  readonly eventType?: EventType
  readonly workflowTaskCompletedEventId?: string | null
  readonly attempt?: number
}

export interface WorkflowCommandHistoryEntry {
  readonly intent: WorkflowCommandIntent
  readonly metadata?: WorkflowCommandHistoryEntryMetadata
}

export interface WorkflowDeterminismFailureMetadata {
  readonly eventId?: string | null
  readonly eventType?: EventType
  readonly failureType?: string
  readonly failureMessage?: string
  readonly retryState?: number
}

export interface WorkflowDeterminismSignalRecord {
  readonly signalName: string
  readonly handlerName?: string
  readonly payloadHash: string
  readonly eventId?: string | null
  readonly workflowTaskCompletedEventId?: string | null
  readonly identity?: string | null
}

export interface WorkflowDeterminismQueryRecord {
  readonly queryName: string
  readonly handlerName?: string
  readonly requestHash: string
  readonly identity?: string | null
  readonly queryId?: string
  readonly resultHash?: string
  readonly failureHash?: string
}

export type WorkflowUpdateDeterminismStage = 'admitted' | 'accepted' | 'rejected' | 'completed'

export interface WorkflowUpdateDeterminismEntry {
  readonly updateId: string
  readonly stage: WorkflowUpdateDeterminismStage
  readonly handlerName?: string
  readonly identity?: string
  readonly sequencingEventId?: string
  readonly messageId?: string
  readonly acceptedEventId?: string
  readonly outcome?: 'success' | 'failure'
  readonly failureMessage?: string
  readonly historyEventId?: string
}

export interface WorkflowDeterminismState {
  readonly commandHistory: readonly WorkflowCommandHistoryEntry[]
  readonly randomValues: readonly number[]
  readonly timeValues: readonly number[]
  readonly logCount?: number
  readonly failureMetadata?: WorkflowDeterminismFailureMetadata
  readonly signals: readonly WorkflowDeterminismSignalRecord[]
  readonly queries: readonly WorkflowDeterminismQueryRecord[]
  readonly updates?: readonly WorkflowUpdateDeterminismEntry[]
}

export interface DeterminismGuardOptions {
  readonly allowBypass?: boolean
  readonly previousState?: WorkflowDeterminismState
  readonly mode?: 'workflow' | 'query'
}

export type DeterminismGuardSnapshot = {
  commandHistory: WorkflowCommandHistoryEntry[]
  randomValues: number[]
  timeValues: number[]
  logCount?: number
  failureMetadata?: WorkflowDeterminismFailureMetadata
  signals: WorkflowDeterminismSignalRecord[]
  queries: WorkflowDeterminismQueryRecord[]
  updates: WorkflowUpdateDeterminismEntry[]
}

export const snapshotToDeterminismState = (snapshot: DeterminismGuardSnapshot): WorkflowDeterminismState => ({
  commandHistory: snapshot.commandHistory.map((entry) => ({
    intent: entry.intent,
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  })),
  randomValues: [...snapshot.randomValues],
  timeValues: [...snapshot.timeValues],
  ...(snapshot.logCount !== undefined ? { logCount: snapshot.logCount } : {}),
  failureMetadata: snapshot.failureMetadata ? { ...snapshot.failureMetadata } : undefined,
  signals: snapshot.signals.map((record) => ({ ...record })),
  queries: snapshot.queries.map((record) => ({ ...record })),
  ...(snapshot.updates.length > 0 ? { updates: snapshot.updates.map((entry) => ({ ...entry })) } : {}),
})

export type RecordedCommandKind = 'new' | 'replay'

export class DeterminismGuard {
  readonly #allowBypass: boolean
  readonly #previous: WorkflowDeterminismState | undefined
  readonly #mode: 'workflow' | 'query'
  readonly snapshot: DeterminismGuardSnapshot
  #commandIndex = 0
  #randomIndex = 0
  #timeIndex = 0
  #logIndex = 0
  #signalIndex = 0
  #queryIndex = 0

  constructor(options: DeterminismGuardOptions = {}) {
    this.#allowBypass = options.allowBypass ?? false
    this.#previous = options.previousState
    this.#mode = options.mode ?? 'workflow'
    this.snapshot = {
      commandHistory: [],
      randomValues: [],
      timeValues: [],
      signals: [],
      queries: [],
      updates: [],
    }
  }

  isQueryMode(): boolean {
    return this.#mode === 'query'
  }

  hasUpdateCompletion(updateId: string): boolean {
    return this.getUpdateCompletion(updateId) !== undefined
  }

  getUpdateCompletion(updateId: string): WorkflowUpdateDeterminismEntry | undefined {
    const completed = (entry: WorkflowUpdateDeterminismEntry) =>
      entry.updateId === updateId && entry.stage === 'completed'
    return this.snapshot.updates.find(completed) ?? (this.#previous?.updates ?? []).find(completed)
  }

  recordCommand(intent: WorkflowCommandIntent): RecordedCommandKind {
    const previousEntry = this.#previous?.commandHistory[this.#commandIndex]

    if (this.#mode === 'query' && !previousEntry) {
      throw new WorkflowQueryViolationError(
        `Workflow query cannot emit new command "${intent.kind}"; queries must be read-only`,
      )
    }

    let kind: RecordedCommandKind = 'new'
    if (!this.#allowBypass && this.#previous) {
      if (previousEntry) {
        const expected = previousEntry.intent
        if (!expected) {
          throw new WorkflowNondeterminismError('Workflow emitted new command on replay', {
            hint: `commandIndex=${this.#commandIndex}`,
            received: intent,
          })
        }
        if (!intentsEqual(expected, intent)) {
          throw new WorkflowNondeterminismError('Workflow command intent mismatch during replay', {
            hint: `commandIndex=${this.#commandIndex}`,
            expected,
            received: intent,
          })
        }
        kind = 'replay'
      }
    }

    if (this.#mode === 'query') {
      kind = 'replay'
    }
    this.snapshot.commandHistory.push({ intent })
    this.#commandIndex += 1
    return kind
  }

  getPreviousIntent(index: number): WorkflowCommandIntent | undefined {
    if (!this.#previous) {
      return undefined
    }
    return this.#previous.commandHistory[index]?.intent
  }

  nextRandom(generate: () => number): number {
    if (this.#mode === 'query') {
      const expected = this.#previous?.randomValues[this.#randomIndex]
      if (expected === undefined) {
        throw new WorkflowQueryViolationError('Workflow query cannot generate new random values')
      }
      this.snapshot.randomValues.push(expected)
      this.#randomIndex += 1
      return expected
    }

    if (!this.#allowBypass && this.#previous) {
      const expected = this.#previous.randomValues[this.#randomIndex]
      if (expected !== undefined) {
        this.snapshot.randomValues.push(expected)
        this.#randomIndex += 1
        return expected
      }
    }
    const value = generate()
    if (!Number.isFinite(value)) {
      throw new WorkflowNondeterminismError('Random value must be a finite number', {
        received: value,
      })
    }
    this.snapshot.randomValues.push(value)
    this.#randomIndex += 1
    return value
  }

  nextTime(generate: () => number): number {
    if (this.#mode === 'query') {
      const expected = this.#previous?.timeValues[this.#timeIndex]
      if (expected === undefined) {
        throw new WorkflowQueryViolationError('Workflow query cannot advance workflow time')
      }
      this.snapshot.timeValues.push(expected)
      this.#timeIndex += 1
      return expected
    }

    if (!this.#allowBypass && this.#previous) {
      const expected = this.#previous.timeValues[this.#timeIndex]
      if (expected !== undefined) {
        this.snapshot.timeValues.push(expected)
        this.#timeIndex += 1
        return expected
      }
    }
    const value = generate()
    if (!Number.isFinite(value)) {
      throw new WorkflowNondeterminismError('Time value must be a finite number', {
        received: value,
      })
    }
    this.snapshot.timeValues.push(value)
    this.#timeIndex += 1
    return value
  }

  recordLog(): boolean {
    const previousCount = !this.#allowBypass && this.#previous ? (this.#previous.logCount ?? 0) : 0
    const shouldEmit = this.#mode !== 'query' && (!this.#previous || this.#logIndex >= previousCount)
    this.#logIndex += 1
    this.snapshot.logCount = this.#logIndex
    return shouldEmit
  }

  recordSignalDelivery(entry: RecordSignalDeliveryInput): void {
    const payloadHash = stableStringify(entry.payload)
    const record: WorkflowDeterminismSignalRecord = {
      signalName: entry.signalName,
      handlerName: entry.handlerName,
      payloadHash,
      eventId: entry.eventId ?? null,
      workflowTaskCompletedEventId: entry.workflowTaskCompletedEventId ?? null,
      identity: entry.identity ?? null,
    }
    if (!this.#allowBypass && this.#previous) {
      const expected = this.#previous.signals?.[this.#signalIndex]
      if (expected && expected.handlerName !== undefined && !signalsEqual(expected, record)) {
        throw new WorkflowNondeterminismError('Workflow received unexpected signal delivery during replay', {
          expected,
          received: record,
          hint: `signalIndex=${this.#signalIndex}`,
        })
      }
    }
    this.snapshot.signals.push(record)
    this.#signalIndex += 1
  }

  recordQueryEvaluation(entry: RecordQueryEvaluationInput): void {
    const requestHash = stableStringify(entry.request)
    const resultHash = entry.result !== undefined ? stableStringify(entry.result) : undefined
    const failureHash = entry.error !== undefined ? stableStringify(entry.error) : undefined
    const record: WorkflowDeterminismQueryRecord = {
      queryName: entry.queryName,
      handlerName: entry.handlerName,
      requestHash,
      identity: entry.identity ?? null,
      queryId: entry.queryId,
      ...(resultHash ? { resultHash } : {}),
      ...(failureHash ? { failureHash } : {}),
    }
    if (!this.#allowBypass && this.#previous && this.#mode !== 'query') {
      const expected = this.#previous.queries?.[this.#queryIndex]
      if (expected && expected.handlerName !== undefined && !queriesEqual(expected, record)) {
        throw new WorkflowNondeterminismError('Workflow evaluated query with unexpected result during replay', {
          expected,
          received: record,
          hint: `queryIndex=${this.#queryIndex}`,
        })
      }
    }
    this.snapshot.queries.push(record)
    this.#queryIndex += 1
  }

  recordUpdate(entry: WorkflowUpdateDeterminismEntry): void {
    this.snapshot.updates.push(entry)
  }

  assertReplayComplete(): void {
    if (this.#allowBypass || !this.#previous) {
      return
    }
    const expectedCommands = this.#previous.commandHistory.length
    const expectedRandom = this.#previous.randomValues.length
    const expectedTime = this.#previous.timeValues.length
    const missingCommands = expectedCommands - this.#commandIndex
    const missingRandom = expectedRandom - this.#randomIndex
    const missingTime = expectedTime - this.#timeIndex
    if (missingCommands <= 0 && missingRandom <= 0 && missingTime <= 0) {
      return
    }
    throw new WorkflowNondeterminismError('Workflow did not replay all history entries', {
      hint: `missingCommands=${Math.max(0, missingCommands)} missingRandom=${Math.max(0, missingRandom)} missingTime=${Math.max(0, missingTime)}`,
    })
  }
}

export const intentsEqual = (a: WorkflowCommandIntent | undefined, b: WorkflowCommandIntent | undefined): boolean => {
  if (!a || !b) {
    return a === b
  }
  if (a.kind !== b.kind) {
    return false
  }
  if (a.sequence !== b.sequence) {
    return false
  }
  const signatureA = stableIntentSignature(normalizeIntentForComparison(a))
  const signatureB = stableIntentSignature(normalizeIntentForComparison(b))
  return signatureA === signatureB
}

const DEFAULT_CHILD_WORKFLOW_TASK_TIMEOUT_MS = 10_000
const DEFAULT_ACTIVITY_HEARTBEAT_TIMEOUT_MS = 0
const DEFAULT_WORKFLOW_RUN_TIMEOUT_MS = 0
const DEFAULT_WORKFLOW_EXECUTION_TIMEOUT_MS = 0
const DEFAULT_WORKFLOW_ID_REUSE_POLICY = WorkflowIdReusePolicy.ALLOW_DUPLICATE

const normalizeIntentForComparison = (intent: WorkflowCommandIntent): WorkflowCommandIntent => {
  switch (intent.kind) {
    case 'schedule-activity':
      return normalizeScheduleActivityIntent(intent)
    case 'start-child-workflow':
      return normalizeStartChildWorkflowIntent(intent)
    default:
      return intent
  }
}

const normalizeScheduleActivityIntent = (intent: WorkflowCommandIntent): WorkflowCommandIntent => {
  if (intent.kind !== 'schedule-activity') {
    return intent
  }
  const timeouts = { ...intent.timeouts }
  const scheduleToCloseTimeoutMs = timeouts.scheduleToCloseTimeoutMs
  const startToCloseTimeoutMs = timeouts.startToCloseTimeoutMs
  if (timeouts.scheduleToStartTimeoutMs === undefined || timeouts.scheduleToStartTimeoutMs === null) {
    if (scheduleToCloseTimeoutMs !== undefined && scheduleToCloseTimeoutMs !== null) {
      timeouts.scheduleToStartTimeoutMs = scheduleToCloseTimeoutMs
    } else if (startToCloseTimeoutMs !== undefined && startToCloseTimeoutMs !== null) {
      timeouts.scheduleToStartTimeoutMs = startToCloseTimeoutMs
    }
  }
  if (timeouts.heartbeatTimeoutMs === undefined || timeouts.heartbeatTimeoutMs === null) {
    timeouts.heartbeatTimeoutMs = DEFAULT_ACTIVITY_HEARTBEAT_TIMEOUT_MS
  }
  return {
    ...intent,
    timeouts,
  }
}

const normalizeStartChildWorkflowIntent = (intent: WorkflowCommandIntent): WorkflowCommandIntent => {
  if (intent.kind !== 'start-child-workflow') {
    return intent
  }
  const timeouts = { ...intent.timeouts }
  if (timeouts.workflowExecutionTimeoutMs === undefined || timeouts.workflowExecutionTimeoutMs === null) {
    timeouts.workflowExecutionTimeoutMs = DEFAULT_WORKFLOW_EXECUTION_TIMEOUT_MS
  }
  if (timeouts.workflowRunTimeoutMs === undefined || timeouts.workflowRunTimeoutMs === null) {
    timeouts.workflowRunTimeoutMs = DEFAULT_WORKFLOW_RUN_TIMEOUT_MS
  }
  if (timeouts.workflowTaskTimeoutMs === undefined || timeouts.workflowTaskTimeoutMs === null) {
    timeouts.workflowTaskTimeoutMs = DEFAULT_CHILD_WORKFLOW_TASK_TIMEOUT_MS
  }
  return {
    ...intent,
    timeouts,
    workflowIdReusePolicy: intent.workflowIdReusePolicy ?? DEFAULT_WORKFLOW_ID_REUSE_POLICY,
  }
}

const stableIntentSignature = (intent: WorkflowCommandIntent): string =>
  stableStringify(intent, (_key, value) => {
    if (typeof value === 'bigint') {
      return value.toString()
    }
    if (value instanceof Uint8Array) {
      return Buffer.from(value).toString('base64')
    }
    if (value && typeof value === 'object' && 'kind' in value && 'sequence' in value) {
      return value
    }
    return value
  })

type JsonReplacer = (this: unknown, key: string, value: unknown) => unknown

export const stableStringify = (value: unknown, replacer?: JsonReplacer): string => {
  const seen = new WeakSet<object>()
  const stable = (key: string, input: unknown): unknown => {
    if (replacer) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      input = replacer.call(this, key, input)
    }
    if (!input || typeof input !== 'object') {
      return input
    }
    if (seen.has(input as object)) {
      return '[Circular]'
    }
    seen.add(input as object)
    if (Array.isArray(input)) {
      return input.map((item, index) => stable(String(index), item))
    }
    const entries = Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, stable(k, v)] as const)
    entries.sort(([lhs], [rhs]) => lhs.localeCompare(rhs))
    return Object.fromEntries(entries)
  }
  return JSON.stringify(stable('', value))
}

export interface RecordSignalDeliveryInput {
  readonly signalName: string
  readonly handlerName?: string
  readonly payload: unknown
  readonly eventId?: string | null
  readonly workflowTaskCompletedEventId?: string | null
  readonly identity?: string | null
}

export interface RecordQueryEvaluationInput {
  readonly queryName: string
  readonly handlerName?: string
  readonly request: unknown
  readonly identity?: string | null
  readonly queryId?: string
  readonly result?: unknown
  readonly error?: unknown
}

const normalizeNullableString = (value: string | null | undefined): string | null =>
  value === undefined ? null : value

const stringsEqual = (left: string | null | undefined, right: string | null | undefined): boolean =>
  normalizeNullableString(left) === normalizeNullableString(right)

const signalsEqual = (expected: WorkflowDeterminismSignalRecord, actual: WorkflowDeterminismSignalRecord): boolean =>
  expected.signalName === actual.signalName &&
  expected.handlerName === actual.handlerName &&
  expected.payloadHash === actual.payloadHash &&
  stringsEqual(expected.eventId, actual.eventId) &&
  stringsEqual(expected.workflowTaskCompletedEventId, actual.workflowTaskCompletedEventId) &&
  stringsEqual(expected.identity, actual.identity)

const queriesEqual = (expected: WorkflowDeterminismQueryRecord, actual: WorkflowDeterminismQueryRecord): boolean =>
  expected.queryName === actual.queryName &&
  expected.handlerName === actual.handlerName &&
  expected.requestHash === actual.requestHash &&
  stringsEqual(expected.identity, actual.identity) &&
  stringsEqual(expected.queryId, actual.queryId) &&
  expected.resultHash === actual.resultHash &&
  expected.failureHash === actual.failureHash
