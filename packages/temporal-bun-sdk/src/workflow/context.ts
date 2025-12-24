import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import type {
  CancelTimerCommandIntent,
  CancelWorkflowCommandIntent,
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
import type {
  WorkflowUpdateDefinition,
  WorkflowUpdateDefinitions,
  WorkflowUpdateHandler,
  WorkflowUpdateValidator,
} from './definition'
import type { DeterminismGuard, RecordedCommandKind, WorkflowRetryPolicyInput } from './determinism'
import { ContinueAsNewWorkflowError, WorkflowBlockedError, WorkflowQueryHandlerMissingError } from './errors'
import {
  normalizeInboundArguments,
  type WorkflowQueryHandle,
  type WorkflowQueryHandlerOptions,
  type WorkflowQueryMetadata,
  type WorkflowQueryRequest,
  type WorkflowQueryResolver,
  type WorkflowSignalDelivery,
  type WorkflowSignalDeliveryInput,
  type WorkflowSignalHandle,
  type WorkflowSignalHandler,
  type WorkflowSignalHandlerOptions,
  type WorkflowSignalMetadata,
} from './inbound'

export type WorkflowCommandIntentId = string

const DEFAULT_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS = 10_000
const MARKER_SIDE_EFFECT = 'temporal-bun-sdk/side-effect'
const MARKER_VERSION = 'temporal-bun-sdk/get-version'
const MARKER_PATCH = 'temporal-bun-sdk/patch'
const MARKER_LOCAL_ACTIVITY = 'temporal-bun-sdk/local-activity'

export interface WorkflowInfo {
  readonly namespace: string
  readonly taskQueue: string
  readonly workflowId: string
  readonly runId: string
  readonly workflowType: string
}

export interface ScheduleActivityOptions {
  readonly activityId?: string
  readonly taskQueue?: string
  readonly scheduleToCloseTimeoutMs?: number
  readonly scheduleToStartTimeoutMs?: number
  readonly startToCloseTimeoutMs?: number
  readonly heartbeatTimeoutMs?: number
  readonly retry?: WorkflowRetryPolicyInput
  readonly requestEagerExecution?: boolean
}

export interface StartTimerOptions {
  readonly timerId?: string
  readonly timeoutMs: number
}

export interface CancelActivityOptions {
  readonly scheduledEventId?: string | number | bigint
}

export interface CancelTimerOptions {
  readonly startedEventId?: string | number | bigint
}

export interface StartChildWorkflowOptions {
  readonly workflowId?: string
  readonly namespace?: string
  readonly taskQueue?: string
  readonly workflowExecutionTimeoutMs?: number
  readonly workflowRunTimeoutMs?: number
  readonly workflowTaskTimeoutMs?: number
  readonly parentClosePolicy?: number
  readonly workflowIdReusePolicy?: number
  readonly retry?: WorkflowRetryPolicyInput
  readonly cronSchedule?: string
}

export interface SignalExternalWorkflowOptions {
  readonly namespace?: string
  readonly workflowId?: string
  readonly runId?: string
  readonly childWorkflowOnly?: boolean
  readonly reason?: string
}

export interface ContinueAsNewOptions {
  readonly workflowType?: string
  readonly taskQueue?: string
  readonly input?: unknown[]
  readonly workflowRunTimeoutMs?: number
  readonly workflowTaskTimeoutMs?: number
  readonly backoffStartIntervalMs?: number
  readonly retry?: WorkflowRetryPolicyInput
  readonly cronSchedule?: string
}

export interface UpsertSearchAttributesOptions {
  readonly attributes: Record<string, unknown>
}

export interface UpsertMemoOptions {
  readonly memo: Record<string, unknown>
}

export interface RecordMarkerOptions {
  readonly markerName: string
  readonly details?: Record<string, unknown>
}

export interface SideEffectOptions<T> {
  readonly reuseOnReplay?: boolean
  readonly identifier?: string
  readonly compute: () => T
}

export interface GetVersionOptions {
  readonly changeId: string
  readonly minSupported: number
  readonly maxSupported: number
}

export interface LocalActivityOptions {
  readonly activityId?: string
  readonly handler?: (...args: unknown[]) => unknown | Promise<unknown>
}

export interface WorkflowScheduledCommandRef {
  readonly id: WorkflowCommandIntentId
  readonly kind: WorkflowCommandIntent['kind']
  readonly sequence: number
  readonly activityId?: string
  readonly timerId?: string
  readonly result?: unknown
}

export interface WorkflowActivities {
  schedule(
    activityType: string,
    args?: unknown[],
    options?: ScheduleActivityOptions,
  ): Effect.Effect<unknown, never, never>

  cancel(
    activityId: string,
    options?: CancelActivityOptions,
  ): Effect.Effect<WorkflowScheduledCommandRef, WorkflowBlockedError | Error, never>
}

export interface WorkflowTimers {
  start(options: StartTimerOptions): Effect.Effect<{ timerId: string }, never, never>

  cancel(timerId: string, options?: CancelTimerOptions): Effect.Effect<WorkflowScheduledCommandRef, never, never>
}

export interface WorkflowChildWorkflows {
  start(
    workflowType: string,
    args?: unknown[],
    options?: StartChildWorkflowOptions,
  ): Effect.Effect<WorkflowScheduledCommandRef, never, never>
}

export interface WorkflowSignalClient {
  signal(
    signalName: string,
    args?: unknown[],
    options?: SignalExternalWorkflowOptions,
  ): Effect.Effect<WorkflowScheduledCommandRef, never, never>
  on<I>(
    handle: WorkflowSignalHandle<I>,
    handler: WorkflowSignalHandler<I, void>,
    options?: WorkflowSignalHandlerOptions,
  ): Effect.Effect<void, WorkflowBlockedError | unknown, never>
  waitFor<I>(
    handle: WorkflowSignalHandle<I>,
    options?: WorkflowSignalHandlerOptions,
  ): Effect.Effect<WorkflowSignalDelivery<I>, WorkflowBlockedError | unknown, never>
  drain<I>(
    handle: WorkflowSignalHandle<I>,
    options?: WorkflowSignalHandlerOptions,
  ): Effect.Effect<readonly WorkflowSignalDelivery<I>[], WorkflowBlockedError | unknown, never>

  requestCancel(
    workflowId: string,
    options?: SignalExternalWorkflowOptions,
  ): Effect.Effect<WorkflowScheduledCommandRef, never, never>
}

export interface WorkflowQueries {
  register<I, O>(
    handle: WorkflowQueryHandle<I, O>,
    resolver: WorkflowQueryResolver<I, O>,
    options?: WorkflowQueryHandlerOptions,
  ): Effect.Effect<void, never, never>
  resolve<I, O>(
    handle: WorkflowQueryHandle<I, O>,
    input?: I,
    metadata?: WorkflowQueryMetadata,
  ): Effect.Effect<O, WorkflowQueryHandlerMissingError | unknown, never>
}

export interface WorkflowDeterminismHelpers {
  now(): number
  random(): number
  sideEffect<T>(options: SideEffectOptions<T>): T
  getVersion(options: GetVersionOptions): number
  patched(patchId: string): boolean
  deprecatePatch(patchId: string): void
  recordMarker(options: RecordMarkerOptions): void
  localActivity<T>(activityType: string, args?: unknown[], options?: LocalActivityOptions): T
}

export interface WorkflowRuntimeServices {
  readonly activities: WorkflowActivities
  readonly timers: WorkflowTimers
  readonly childWorkflows: WorkflowChildWorkflows
  readonly signals: WorkflowSignalClient
  readonly queries: WorkflowQueries
  readonly determinism: WorkflowDeterminismHelpers
  readonly updates: WorkflowUpdates
  readonly upsertSearchAttributes: (attributes: Record<string, unknown>) => void
  readonly upsertMemo: (memo: Record<string, unknown>) => void
  readonly cancelWorkflow: (details?: unknown[]) => void
  continueAsNew(options?: ContinueAsNewOptions): Effect.Effect<never, ContinueAsNewWorkflowError, never>
}

export interface WorkflowContext<I> extends WorkflowRuntimeServices {
  readonly input: I
  readonly info: WorkflowInfo
}

export interface CreateWorkflowContextParams<I> {
  readonly input: I
  readonly info: WorkflowInfo
  readonly determinismGuard: DeterminismGuard
  readonly activityResults?: Map<string, ActivityResolution>
  readonly activityScheduleEventIds?: Map<string, string>
  readonly signalDeliveries?: readonly WorkflowSignalDeliveryInput[]
  readonly timerResults?: ReadonlySet<string>
  readonly updates?: WorkflowUpdateDefinitions
}

export type ActivityResolution = { status: 'completed'; value: unknown } | { status: 'failed'; error: Error }

export class WorkflowCommandContext {
  readonly #info: WorkflowInfo
  readonly #guard: DeterminismGuard
  readonly #intents: WorkflowCommandIntent[] = []
  readonly #activityScheduleEventIds?: Map<string, string>
  #sequence = 0

  constructor(params: { info: WorkflowInfo; guard: DeterminismGuard; activityScheduleEventIds?: Map<string, string> }) {
    this.#info = params.info
    this.#guard = params.guard
    this.#activityScheduleEventIds = params.activityScheduleEventIds
  }

  get intents(): readonly WorkflowCommandIntent[] {
    return this.#intents
  }

  addIntent(intent: WorkflowCommandIntent): RecordedCommandKind {
    const kind = this.#guard.recordCommand(intent)
    if (kind === 'new') {
      this.#intents.push(intent)
    }
    return kind
  }

  nextSequence(): number {
    const seq = this.#sequence
    this.#sequence += 1
    return seq
  }

  resolveScheduledActivityEventId(activityId: string): string | undefined {
    return this.#activityScheduleEventIds?.get(activityId)
  }

  previousIntent(sequence: number): WorkflowCommandIntent | undefined {
    return this.#guard.getPreviousIntent(sequence)
  }

  get info(): WorkflowInfo {
    return this.#info
  }
}

export const createWorkflowContext = <I>(
  params: CreateWorkflowContextParams<I>,
): {
  context: WorkflowContext<I>
  commandContext: WorkflowCommandContext
  queryRegistry: WorkflowQueryRegistry
  updateRegistry: WorkflowUpdateRegistry
} => {
  const commandContext = new WorkflowCommandContext({
    info: params.info,
    guard: params.determinismGuard,
    activityScheduleEventIds: params.activityScheduleEventIds,
  })
  const updateRegistry = new WorkflowUpdateRegistry()

  const activityResults = params.activityResults ?? new Map<string, ActivityResolution>()
  const inboundSignals = new WorkflowInboundSignals({
    guard: params.determinismGuard,
    deliveries: params.signalDeliveries,
  })
  const queryRegistry = new WorkflowQueryRegistry({ guard: params.determinismGuard })

  const activities: WorkflowActivities = {
    schedule(activityType, args = [], options = {}) {
      return Effect.sync(() => {
        const intent = buildScheduleActivityIntent(commandContext, activityType, args, options)
        commandContext.addIntent(intent)
        const resolution = activityResults.get(intent.activityId)
        if (!resolution) {
          // In query mode we must not block; return a deterministic command ref so query
          // handlers can surface the latest known state without introducing new commands.
          if (params.determinismGuard.isQueryMode()) {
            return createCommandRef(intent, { activityId: intent.activityId })
          }
          throw new WorkflowBlockedError(`Activity ${intent.activityId} pending`)
        }
        if (resolution.status === 'failed') {
          throw resolution.error
        }
        // When the activity result is already available (e.g., during replay/query),
        // return the resolved value instead of a command reference so workflow code
        // sees the decoded activity output.
        return resolution.value
      })
    },
    cancel(activityId, options = {}) {
      return Effect.sync(() => {
        const intent = buildRequestCancelActivityIntent(commandContext, activityId, options)
        commandContext.addIntent(intent)
        return createCommandRef(intent, { activityId })
      })
    },
  }

  const timers: WorkflowTimers = {
    start(options) {
      return Effect.sync(() => {
        if (!options || typeof options.timeoutMs !== 'number' || options.timeoutMs <= 0) {
          throw new WorkflowBlockedError('Timer timeoutMs must be a positive number')
        }
        const intent = buildStartTimerIntent(commandContext, options)
        commandContext.addIntent(intent)
        // If the timer hasn't fired yet, block the workflow so it will resume
        // when the corresponding TimerFired event is observed on replay.
        if (!params.timerResults?.has(intent.timerId)) {
          if (params.determinismGuard.isQueryMode()) {
            return { timerId: intent.timerId }
          }
          throw new WorkflowBlockedError(`Timer ${intent.timerId} pending`)
        }
        return { timerId: intent.timerId }
      })
    },
    cancel(timerId, options = {}) {
      return Effect.sync(() => {
        const intent = buildCancelTimerIntent(commandContext, timerId, options)
        commandContext.addIntent(intent)
        return createCommandRef(intent, { timerId })
      })
    },
  }

  const childWorkflows: WorkflowChildWorkflows = {
    start(workflowType, args = [], options = {}) {
      return Effect.sync(() => {
        const intent = buildStartChildWorkflowIntent(commandContext, workflowType, args, options)
        commandContext.addIntent(intent)
        return createCommandRef(intent)
      })
    },
  }

  const signals: WorkflowSignalClient = {
    signal(signalName, args = [], options = {}) {
      return Effect.sync(() => {
        const intent = buildSignalExternalWorkflowIntent(commandContext, signalName, args, options)
        commandContext.addIntent(intent)
        return createCommandRef(intent)
      })
    },
    on(handle, handler, options) {
      return inboundSignals.on(handle, handler, options)
    },
    waitFor(handle, options) {
      return inboundSignals.waitFor(handle, options)
    },
    drain(handle, options) {
      return inboundSignals.drain(handle, options)
    },
    requestCancel(workflowId, options = {}) {
      return Effect.sync(() => {
        const intent = buildRequestCancelExternalWorkflowIntent(commandContext, workflowId, options)
        commandContext.addIntent(intent)
        return createCommandRef(intent)
      })
    },
  }

  const queries: WorkflowQueries = {
    register(handle, resolver, options) {
      const effect = queryRegistry.register(handle, resolver, options)
      // Ensure registration occurs immediately even if caller forgets to yield/await.
      Effect.runSync(effect)
      return effect
    },
    resolve(handle, input, metadata) {
      return queryRegistry.resolve(handle, input, metadata)
    },
  }

  const determinism: WorkflowDeterminismHelpers = {
    now: () => params.determinismGuard.nextTime(() => Date.now()),
    random: () => params.determinismGuard.nextRandom(() => Math.random()),
    sideEffect: <T>({ compute, identifier }: SideEffectOptions<T>) =>
      runSideEffect<T>({
        commandContext,
        markerName: MARKER_SIDE_EFFECT,
        identifier,
        compute,
      }),
    getVersion: ({ changeId, minSupported, maxSupported }) =>
      runGetVersion({ commandContext, changeId, minSupported, maxSupported }),
    patched: (patchId) => runPatchMarker({ commandContext, patchId, deprecated: false }),
    deprecatePatch: (patchId) => {
      runPatchMarker({ commandContext, patchId, deprecated: true })
    },
    recordMarker: (options) => {
      const intent = buildRecordMarkerIntent(commandContext, options.markerName, options.details)
      commandContext.addIntent(intent)
    },
    localActivity: (activityType, args = [], options) =>
      runLocalActivity({
        commandContext,
        activityType,
        args,
        handler: options?.handler,
        activityId: options?.activityId,
      }),
  }

  const upsertSearchAttributes = (attributes: Record<string, unknown>) => {
    const intent = buildUpsertSearchAttributesIntent(commandContext, attributes)
    commandContext.addIntent(intent)
  }

  const upsertMemo = (memo: Record<string, unknown>) => {
    const intent = buildModifyWorkflowPropertiesIntent(commandContext, memo)
    commandContext.addIntent(intent)
  }

  const cancelWorkflow = (details?: unknown[]) => {
    const intent = buildCancelWorkflowIntent(commandContext, details)
    commandContext.addIntent(intent)
  }

  const updates: WorkflowUpdates = {
    register(definition, handler, options) {
      updateRegistry.register(definition, handler, options?.validator)
    },
    registerDefault(handler) {
      updateRegistry.registerDefault(handler)
    },
  }

  if (params.updates) {
    for (const definition of params.updates) {
      // Some callers supply update definitions as metadata and register handlers at runtime.
      // Only auto-register when a handler is present to avoid throwing during workflow replay.
      if ('handler' in definition && typeof definition.handler === 'function') {
        updateRegistry.register(definition, definition.handler, definition.validator)
      }
    }
  }

  const context: WorkflowContext<I> = {
    input: params.input,
    info: params.info,
    activities,
    timers,
    childWorkflows,
    signals,
    queries,
    determinism,
    updates,
    upsertSearchAttributes,
    upsertMemo,
    cancelWorkflow,
    continueAsNew(options) {
      return Effect.sync(() => {
        const intent = buildContinueAsNewIntent(commandContext, options)
        commandContext.addIntent(intent)
        return intent
      }).pipe(Effect.flatMap(() => Effect.fail(new ContinueAsNewWorkflowError())))
    },
  }

  return { context, commandContext, queryRegistry, updateRegistry }
}

const createCommandRef = (
  intent: WorkflowCommandIntent,
  extras?: Partial<Pick<WorkflowScheduledCommandRef, 'activityId' | 'timerId' | 'result'>>,
): WorkflowScheduledCommandRef => ({
  id: intent.id,
  kind: intent.kind,
  sequence: intent.sequence,
  ...extras,
})

const buildScheduleActivityIntent = (
  ctx: WorkflowCommandContext,
  activityType: string,
  args: unknown[],
  options: ScheduleActivityOptions,
): ScheduleActivityCommandIntent => {
  const sequence = ctx.nextSequence()
  const activityId = options.activityId ?? `activity-${sequence}`
  const taskQueue = options.taskQueue ?? ctx.info.taskQueue
  const startToCloseTimeoutMs =
    options.startToCloseTimeoutMs ?? options.scheduleToCloseTimeoutMs ?? DEFAULT_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS
  const scheduleToCloseTimeoutMs = options.scheduleToCloseTimeoutMs ?? startToCloseTimeoutMs
  return {
    id: `schedule-activity-${sequence}`,
    kind: 'schedule-activity',
    sequence,
    activityType,
    activityId,
    taskQueue,
    input: args,
    timeouts: {
      scheduleToCloseTimeoutMs,
      scheduleToStartTimeoutMs: options.scheduleToStartTimeoutMs,
      startToCloseTimeoutMs,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    },
    retry: options.retry,
    requestEagerExecution: options.requestEagerExecution,
  }
}

const buildStartTimerIntent = (ctx: WorkflowCommandContext, options: StartTimerOptions): StartTimerCommandIntent => {
  const sequence = ctx.nextSequence()
  const previous = ctx.previousIntent(sequence)
  const timeoutMs =
    previous && previous.kind === 'start-timer' && typeof previous.timeoutMs === 'number'
      ? previous.timeoutMs
      : options.timeoutMs
  return {
    id: `start-timer-${sequence}`,
    kind: 'start-timer',
    sequence,
    timerId: options.timerId ?? `timer-${sequence}`,
    timeoutMs,
  }
}

const buildCancelTimerIntent = (
  ctx: WorkflowCommandContext,
  timerId: string,
  options: CancelTimerOptions,
): CancelTimerCommandIntent => {
  const sequence = ctx.nextSequence()
  return {
    id: `cancel-timer-${sequence}`,
    kind: 'cancel-timer',
    sequence,
    timerId,
    startedEventId: options.startedEventId ? String(options.startedEventId) : undefined,
  }
}

const buildRequestCancelActivityIntent = (
  ctx: WorkflowCommandContext,
  activityId: string,
  options: CancelActivityOptions,
): RequestCancelActivityCommandIntent => {
  const sequence = ctx.nextSequence()
  const scheduledEventId = options.scheduledEventId ?? ctx.resolveScheduledActivityEventId(activityId)
  return {
    id: `cancel-activity-${sequence}`,
    kind: 'request-cancel-activity',
    sequence,
    activityId,
    scheduledEventId: scheduledEventId !== undefined ? String(scheduledEventId) : undefined,
  }
}

const buildStartChildWorkflowIntent = (
  ctx: WorkflowCommandContext,
  workflowType: string,
  args: unknown[],
  options: StartChildWorkflowOptions,
): StartChildWorkflowCommandIntent => {
  const sequence = ctx.nextSequence()
  return {
    id: `start-child-workflow-${sequence}`,
    kind: 'start-child-workflow',
    sequence,
    workflowType,
    workflowId: options.workflowId ?? `${ctx.info.workflowId}-child-${sequence}`,
    namespace: options.namespace ?? ctx.info.namespace,
    taskQueue: options.taskQueue ?? ctx.info.taskQueue,
    input: args,
    timeouts: {
      workflowExecutionTimeoutMs: options.workflowExecutionTimeoutMs,
      workflowRunTimeoutMs: options.workflowRunTimeoutMs,
      workflowTaskTimeoutMs: options.workflowTaskTimeoutMs,
    },
    parentClosePolicy: options.parentClosePolicy,
    workflowIdReusePolicy: options.workflowIdReusePolicy,
    retry: options.retry,
    cronSchedule: options.cronSchedule,
  }
}

const buildRequestCancelExternalWorkflowIntent = (
  ctx: WorkflowCommandContext,
  workflowId: string,
  options: SignalExternalWorkflowOptions,
): RequestCancelExternalWorkflowCommandIntent => {
  const sequence = ctx.nextSequence()
  return {
    id: `cancel-external-${sequence}`,
    kind: 'request-cancel-external-workflow',
    sequence,
    namespace: options.namespace ?? ctx.info.namespace,
    workflowId,
    runId: options.runId,
    childWorkflowOnly: options.childWorkflowOnly ?? false,
    reason: options.reason,
  }
}

const buildCancelWorkflowIntent = (ctx: WorkflowCommandContext, details?: unknown[]): CancelWorkflowCommandIntent => {
  const sequence = ctx.nextSequence()
  return {
    id: `cancel-workflow-${sequence}`,
    kind: 'cancel-workflow',
    sequence,
    details,
  }
}

const buildRecordMarkerIntent = (
  ctx: WorkflowCommandContext,
  markerName: string,
  details?: Record<string, unknown>,
): RecordMarkerCommandIntent => {
  const sequence = ctx.nextSequence()
  return {
    id: `record-marker-${sequence}`,
    kind: 'record-marker',
    sequence,
    markerName,
    details,
  }
}

const buildUpsertSearchAttributesIntent = (
  ctx: WorkflowCommandContext,
  attributes: Record<string, unknown>,
): UpsertSearchAttributesCommandIntent => {
  const sequence = ctx.nextSequence()
  return {
    id: `upsert-search-attributes-${sequence}`,
    kind: 'upsert-search-attributes',
    sequence,
    searchAttributes: attributes,
  }
}

const buildModifyWorkflowPropertiesIntent = (
  ctx: WorkflowCommandContext,
  memo: Record<string, unknown>,
): ModifyWorkflowPropertiesCommandIntent => {
  const sequence = ctx.nextSequence()
  return {
    id: `modify-workflow-properties-${sequence}`,
    kind: 'modify-workflow-properties',
    sequence,
    memo,
  }
}

const runSideEffect = <T>(params: {
  commandContext: WorkflowCommandContext
  markerName: string
  identifier?: string
  compute: () => T
}): T => {
  const sequence = params.commandContext.nextSequence()
  const previous = params.commandContext.previousIntent(sequence)
  if (previous && previous.kind === 'record-marker' && previous.markerName === params.markerName) {
    const intent: RecordMarkerCommandIntent = {
      ...previous,
      sequence,
    }
    params.commandContext.addIntent(intent)
    const details = intent.details ?? {}
    if ('result' in details) {
      return details.result as T
    }
    return details as T
  }

  const value = params.compute()
  const intent: RecordMarkerCommandIntent = {
    id: `record-marker-${sequence}`,
    kind: 'record-marker',
    sequence,
    markerName: params.markerName,
    details: {
      ...(params.identifier ? { id: params.identifier } : {}),
      result: value,
    },
  }
  params.commandContext.addIntent(intent)
  return value
}

const runGetVersion = (params: {
  commandContext: WorkflowCommandContext
  changeId: string
  minSupported: number
  maxSupported: number
}): number => {
  const sequence = params.commandContext.nextSequence()
  const previous = params.commandContext.previousIntent(sequence)
  if (previous && previous.kind === 'record-marker' && previous.markerName === MARKER_VERSION) {
    const intent: RecordMarkerCommandIntent = { ...previous, sequence }
    params.commandContext.addIntent(intent)
    const details = intent.details ?? {}
    const version = typeof details.version === 'number' ? details.version : undefined
    if (version === undefined) {
      throw new WorkflowBlockedError('Version marker missing version payload')
    }
    return version
  }

  if (params.maxSupported < params.minSupported) {
    throw new WorkflowBlockedError('maxSupported version must be >= minSupported version')
  }
  const version = params.maxSupported
  const intent: RecordMarkerCommandIntent = {
    id: `version-${sequence}`,
    kind: 'record-marker',
    sequence,
    markerName: MARKER_VERSION,
    details: {
      changeId: params.changeId,
      version,
    },
  }
  params.commandContext.addIntent(intent)
  return version
}

const runPatchMarker = (params: {
  commandContext: WorkflowCommandContext
  patchId: string
  deprecated: boolean
}): boolean => {
  const sequence = params.commandContext.nextSequence()
  const previous = params.commandContext.previousIntent(sequence)
  if (previous && previous.kind === 'record-marker' && previous.markerName === MARKER_PATCH) {
    const intent: RecordMarkerCommandIntent = { ...previous, sequence }
    params.commandContext.addIntent(intent)
    return true
  }
  const intent: RecordMarkerCommandIntent = {
    id: `patch-${sequence}`,
    kind: 'record-marker',
    sequence,
    markerName: MARKER_PATCH,
    details: {
      patchId: params.patchId,
      deprecated: params.deprecated,
    },
  }
  params.commandContext.addIntent(intent)
  return true
}

const runLocalActivity = <T>(params: {
  commandContext: WorkflowCommandContext
  activityType: string
  args: unknown[]
  handler?: (...args: unknown[]) => unknown
  activityId?: string
}): T => {
  const sequence = params.commandContext.nextSequence()
  const activityId = params.activityId ?? `local-activity-${sequence}`
  const previous = params.commandContext.previousIntent(sequence)

  const readPreviousResult = (intent: RecordMarkerCommandIntent): T => {
    const details = intent.details ?? {}
    if ('status' in details && details.status === 'failed') {
      const message = typeof details.errorMessage === 'string' ? details.errorMessage : 'Local activity failed'
      throw new Error(message)
    }
    return (details.result as T) ?? (details.payload as T)
  }

  if (previous && previous.kind === 'record-marker' && previous.markerName === MARKER_LOCAL_ACTIVITY) {
    const intent: RecordMarkerCommandIntent = { ...previous, sequence }
    params.commandContext.addIntent(intent)
    return readPreviousResult(intent)
  }

  if (!params.handler) {
    throw new WorkflowBlockedError('Local activity handler is required during initial execution')
  }

  try {
    const value = params.handler(...params.args) as T
    const intent: RecordMarkerCommandIntent = {
      id: `local-activity-${sequence}`,
      kind: 'record-marker',
      sequence,
      markerName: MARKER_LOCAL_ACTIVITY,
      details: {
        activityId,
        activityType: params.activityType,
        status: 'completed',
        result: value,
      },
    }
    params.commandContext.addIntent(intent)
    return value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const intent: RecordMarkerCommandIntent = {
      id: `local-activity-${sequence}`,
      kind: 'record-marker',
      sequence,
      markerName: MARKER_LOCAL_ACTIVITY,
      details: {
        activityId,
        activityType: params.activityType,
        status: 'failed',
        errorMessage: message,
      },
    }
    params.commandContext.addIntent(intent)
    throw error
  }
}

const buildSignalExternalWorkflowIntent = (
  ctx: WorkflowCommandContext,
  signalName: string,
  args: unknown[],
  options: SignalExternalWorkflowOptions,
): SignalExternalWorkflowCommandIntent => {
  const sequence = ctx.nextSequence()
  return {
    id: `signal-external-${sequence}`,
    kind: 'signal-external-workflow',
    sequence,
    namespace: options.namespace ?? ctx.info.namespace,
    workflowId: options.workflowId ?? ctx.info.workflowId,
    runId: options.runId,
    signalName,
    input: args,
    childWorkflowOnly: options.childWorkflowOnly ?? false,
  }
}

const buildContinueAsNewIntent = (
  ctx: WorkflowCommandContext,
  options: ContinueAsNewOptions = {},
): ContinueAsNewWorkflowCommandIntent => {
  const sequence = ctx.nextSequence()
  return {
    id: `continue-as-new-${sequence}`,
    kind: 'continue-as-new',
    sequence,
    workflowType: options.workflowType ?? ctx.info.workflowType,
    taskQueue: options.taskQueue ?? ctx.info.taskQueue,
    input: options.input ?? [],
    timeouts: {
      workflowRunTimeoutMs: options.workflowRunTimeoutMs,
      workflowTaskTimeoutMs: options.workflowTaskTimeoutMs,
    },
    backoffStartIntervalMs: options.backoffStartIntervalMs,
    retry: options.retry,
    cronSchedule: options.cronSchedule,
  }
}

interface SignalQueueEntry {
  readonly args: readonly unknown[]
  readonly metadata: WorkflowSignalMetadata
}

class WorkflowInboundSignals {
  readonly #guard: DeterminismGuard
  readonly #buffers = new Map<string, SignalQueueEntry[]>()

  constructor(params: { guard: DeterminismGuard; deliveries?: readonly WorkflowSignalDeliveryInput[] }) {
    this.#guard = params.guard
    for (const delivery of params.deliveries ?? []) {
      const queue = this.#buffers.get(delivery.name) ?? []
      queue.push({ args: [...delivery.args], metadata: delivery.metadata ?? {} })
      this.#buffers.set(delivery.name, queue)
    }
  }

  on<I>(
    handle: WorkflowSignalHandle<I>,
    handler: WorkflowSignalHandler<I, void>,
    options?: WorkflowSignalHandlerOptions,
  ): Effect.Effect<void, WorkflowBlockedError | unknown, never> {
    const entry = this.#shift(handle.name)
    if (!entry) {
      return Effect.fail(new WorkflowBlockedError(`Signal "${handle.name}" not yet delivered`))
    }
    const handlerName = resolveHandlerName(options?.name, handler, handle.name)
    return this.#decode(handle, entry)
      .pipe(Effect.tap((payload) => this.#record(handle.name, handlerName, payload, entry.metadata)))
      .pipe(Effect.flatMap((payload) => handler(payload, entry.metadata)))
  }

  waitFor<I>(
    handle: WorkflowSignalHandle<I>,
    options?: WorkflowSignalHandlerOptions,
  ): Effect.Effect<WorkflowSignalDelivery<I>, WorkflowBlockedError | unknown, never> {
    const entry = this.#shift(handle.name)
    if (!entry) {
      return Effect.fail(new WorkflowBlockedError(`Signal "${handle.name}" not yet delivered`))
    }
    const handlerName = options?.name ?? 'waitFor'
    return this.#decode(handle, entry)
      .pipe(Effect.tap((payload) => this.#record(handle.name, handlerName, payload, entry.metadata)))
      .pipe(Effect.map((payload) => ({ payload, metadata: entry.metadata }) as WorkflowSignalDelivery<I>))
  }

  drain<I>(
    handle: WorkflowSignalHandle<I>,
    options?: WorkflowSignalHandlerOptions,
  ): Effect.Effect<readonly WorkflowSignalDelivery<I>[], WorkflowBlockedError | unknown, never> {
    const entries = this.#drain(handle.name)
    if (entries.length === 0) {
      return Effect.fail(new WorkflowBlockedError(`Signal "${handle.name}" not yet delivered`))
    }
    const handlerName = options?.name ?? 'drain'
    return runSequential(entries, (entry) =>
      this.#decode(handle, entry)
        .pipe(Effect.tap((payload) => this.#record(handle.name, handlerName, payload, entry.metadata)))
        .pipe(Effect.map((payload) => ({ payload, metadata: entry.metadata }) as WorkflowSignalDelivery<I>)),
    )
  }

  #shift(name: string): SignalQueueEntry | undefined {
    const queue = this.#buffers.get(name)
    if (!queue || queue.length === 0) {
      return undefined
    }
    return queue.shift()
  }

  #drain(name: string): SignalQueueEntry[] {
    const queue = this.#buffers.get(name)
    if (!queue || queue.length === 0) {
      return []
    }
    this.#buffers.set(name, [])
    return queue
  }

  #decode<I>(handle: WorkflowSignalHandle<I>, entry: SignalQueueEntry): Effect.Effect<I, unknown, never> {
    const normalized = normalizeInboundArguments(entry.args, handle.decodeArgumentsAsArray)
    return Schema.decodeUnknown(handle.schema)(normalized)
  }

  #record(signalName: string, handlerName: string, payload: unknown, metadata: WorkflowSignalMetadata) {
    return Effect.sync(() =>
      this.#guard.recordSignalDelivery({
        signalName,
        handlerName,
        payload,
        eventId: metadata.eventId ?? null,
        workflowTaskCompletedEventId: metadata.workflowTaskCompletedEventId ?? null,
        identity: metadata.identity ?? null,
      }),
    )
  }
}

export interface WorkflowUpdates {
  register<I, O>(
    definition: WorkflowUpdateDefinition<I, O>,
    handler: WorkflowUpdateHandler<I, O>,
    options?: { validator?: WorkflowUpdateValidator<I> },
  ): void
  registerDefault(handler: WorkflowUpdateHandler<unknown, unknown>): void
}

export interface RegisteredWorkflowUpdate {
  readonly name: string
  readonly input: Schema.Schema<unknown>
  readonly handler: WorkflowUpdateHandler<unknown, unknown>
  readonly validator?: WorkflowUpdateValidator<unknown>
}

export class WorkflowUpdateRegistry {
  #handlers = new Map<string, RegisteredWorkflowUpdate>()
  #defaultHandler: RegisteredWorkflowUpdate | undefined

  register<I, O>(
    definition: WorkflowUpdateDefinition<I, O>,
    handler: WorkflowUpdateHandler<I, O>,
    validator?: WorkflowUpdateValidator<I>,
  ): void {
    if (typeof handler !== 'function') {
      throw new Error(`Workflow update "${definition.name}" must provide a handler`)
    }
    this.#handlers.set(definition.name, {
      name: definition.name,
      input: definition.input as Schema.Schema<unknown>,
      handler: handler as WorkflowUpdateHandler<unknown, unknown>,
      validator: validator as WorkflowUpdateValidator<unknown> | undefined,
    })
  }

  registerDefault(handler: WorkflowUpdateHandler<unknown, unknown>): void {
    this.#defaultHandler = {
      name: '__default__',
      input: Schema.Unknown,
      handler,
    }
  }

  get(name: string): RegisteredWorkflowUpdate | undefined {
    return this.#handlers.get(name)
  }

  getDefault(): RegisteredWorkflowUpdate | undefined {
    return this.#defaultHandler
  }

  list(): RegisteredWorkflowUpdate[] {
    return Array.from(this.#handlers.values())
  }
}

type QueryRegistryEntry = {
  readonly handle: WorkflowQueryHandle<unknown, unknown>
  readonly resolver: WorkflowQueryResolver<unknown, unknown>
  readonly handlerName: string
}

export interface WorkflowQueryEvaluation {
  readonly request: WorkflowQueryRequest
  readonly status: 'success' | 'failure'
  readonly result?: unknown
  readonly error?: unknown
}

export class WorkflowQueryRegistry {
  readonly #guard: DeterminismGuard
  readonly #handlers = new Map<string, QueryRegistryEntry>()

  constructor(params: { guard: DeterminismGuard }) {
    this.#guard = params.guard
  }

  register<I, O>(
    handle: WorkflowQueryHandle<I, O>,
    resolver: WorkflowQueryResolver<I, O>,
    options?: WorkflowQueryHandlerOptions,
  ): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      this.#handlers.set(handle.name, {
        handle: handle as WorkflowQueryHandle<unknown, unknown>,
        resolver: resolver as WorkflowQueryResolver<unknown, unknown>,
        handlerName: options?.name ?? resolver.name ?? handle.name,
      })
    })
  }

  resolve<I, O>(
    handle: WorkflowQueryHandle<I, O>,
    input?: I,
    metadata?: WorkflowQueryMetadata,
  ): Effect.Effect<O, WorkflowQueryHandlerMissingError | unknown, never> {
    const entry = this.#handlers.get(handle.name)
    if (!entry) {
      return Effect.fail(new WorkflowQueryHandlerMissingError(handle.name))
    }
    const invocationMetadata = metadata ?? {}
    const value = (input ?? (undefined as I)) as unknown
    const resolver = entry.resolver as WorkflowQueryResolver<I, O>
    return resolver(value as I, invocationMetadata)
      .pipe(
        Effect.tap((result) =>
          this.#recordQueryEvaluation(
            entry,
            {
              status: 'success',
              decoded: value,
              result,
            },
            invocationMetadata,
            { name: handle.name, id: invocationMetadata.id ?? `local:${handle.name}` },
          ),
        ),
      )
      .pipe(
        Effect.tapError((error) =>
          this.#recordQueryEvaluation(entry, { status: 'failure', decoded: value, error }, invocationMetadata, {
            name: handle.name,
            id: invocationMetadata.id ?? `local:${handle.name}`,
          }),
        ),
      )
  }

  evaluate(
    request: WorkflowQueryRequest,
  ): Effect.Effect<WorkflowQueryEvaluation, WorkflowQueryHandlerMissingError, never> {
    const entry = this.#handlers.get(request.name)
    if (!entry) {
      return Effect.fail(new WorkflowQueryHandlerMissingError(request.name))
    }
    const metadata = request.metadata ?? {}
    const normalized = normalizeInboundArguments(request.args, entry.handle.decodeInputAsArray) ?? {}
    return Schema.decodeUnknown(entry.handle.inputSchema)(normalized)
      .pipe(
        Effect.flatMap((decoded) =>
          (entry.resolver as WorkflowQueryResolver<unknown, unknown>)(decoded, metadata)
            .pipe(Effect.map((result) => ({ status: 'success', decoded, result }) as const))
            .pipe(Effect.catchAll((error) => Effect.succeed({ status: 'failure', decoded, error } as const))),
        ),
      )
      .pipe(Effect.tap((payload) => this.#recordQueryEvaluation(entry, payload, metadata, request)))
      .pipe(
        Effect.map((payload) =>
          payload.status === 'success'
            ? ({ request, status: 'success', result: payload.result } satisfies WorkflowQueryEvaluation)
            : ({ request, status: 'failure', error: payload.error } satisfies WorkflowQueryEvaluation),
        ),
      )
  }

  list(): QueryRegistryEntry[] {
    return Array.from(this.#handlers.values())
  }

  #recordQueryEvaluation(
    entry: QueryRegistryEntry,
    payload:
      | { status: 'success'; decoded: unknown; result: unknown }
      | { status: 'failure'; decoded: unknown; error: unknown },
    metadata: WorkflowQueryMetadata,
    request: { name: string; id?: string },
  ) {
    return Effect.sync(() =>
      this.#guard.recordQueryEvaluation({
        queryName: request.name,
        handlerName: entry.handlerName,
        request: payload.decoded,
        identity: metadata.identity ?? null,
        queryId: request.id,
        result: payload.status === 'success' ? payload.result : undefined,
        error: payload.status === 'failure' ? payload.error : undefined,
      }),
    )
  }
}

const resolveHandlerName = (configured: string | undefined, handler: unknown, fallback: string): string => {
  if (configured) {
    return configured
  }
  if (typeof handler === 'function' && handler.name) {
    return handler.name
  }
  return fallback
}

const runSequential = <A>(
  entries: readonly SignalQueueEntry[],
  factory: (entry: SignalQueueEntry) => Effect.Effect<A, WorkflowBlockedError | unknown, never>,
): Effect.Effect<readonly A[], WorkflowBlockedError | unknown, never> =>
  entries.reduce(
    (effect, entry) =>
      effect.pipe(
        Effect.flatMap((results) =>
          factory(entry).pipe(
            Effect.map((result) => {
              const next = results.slice()
              next.push(result)
              return next as readonly A[]
            }),
          ),
        ),
      ),
    Effect.succeed<readonly A[]>([]) as Effect.Effect<readonly A[], WorkflowBlockedError | unknown, never>,
  )
