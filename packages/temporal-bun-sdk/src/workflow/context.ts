import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import type {
  ContinueAsNewWorkflowCommandIntent,
  ScheduleActivityCommandIntent,
  SignalExternalWorkflowCommandIntent,
  StartChildWorkflowCommandIntent,
  StartTimerCommandIntent,
  WorkflowCommandIntent,
} from './commands'
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
  ): Effect.Effect<WorkflowScheduledCommandRef, never, never>
}

export interface WorkflowTimers {
  start(options: StartTimerOptions): Effect.Effect<WorkflowScheduledCommandRef, never, never>
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
  ): Effect.Effect<void, WorkflowBlockedError, never>
  waitFor<I>(
    handle: WorkflowSignalHandle<I>,
    options?: WorkflowSignalHandlerOptions,
  ): Effect.Effect<WorkflowSignalDelivery<I>, WorkflowBlockedError, never>
  drain<I>(
    handle: WorkflowSignalHandle<I>,
    options?: WorkflowSignalHandlerOptions,
  ): Effect.Effect<readonly WorkflowSignalDelivery<I>[], WorkflowBlockedError, never>
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
  ): Effect.Effect<O, WorkflowQueryHandlerMissingError, never>
}

export interface WorkflowDeterminismHelpers {
  now(): number
  random(): number
}

export interface WorkflowRuntimeServices {
  readonly activities: WorkflowActivities
  readonly timers: WorkflowTimers
  readonly childWorkflows: WorkflowChildWorkflows
  readonly signals: WorkflowSignalClient
  readonly queries: WorkflowQueries
  readonly determinism: WorkflowDeterminismHelpers
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
  readonly signalDeliveries?: readonly WorkflowSignalDeliveryInput[]
}

export type ActivityResolution = { status: 'completed'; value: unknown } | { status: 'failed'; error: Error }

export class WorkflowCommandContext {
  readonly #info: WorkflowInfo
  readonly #guard: DeterminismGuard
  readonly #intents: WorkflowCommandIntent[] = []
  #sequence = 0

  constructor(params: { info: WorkflowInfo; guard: DeterminismGuard }) {
    this.#info = params.info
    this.#guard = params.guard
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
} => {
  const commandContext = new WorkflowCommandContext({ info: params.info, guard: params.determinismGuard })

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
          throw new WorkflowBlockedError(`Activity ${intent.activityId} pending`)
        }
        if (resolution.status === 'failed') {
          throw resolution.error
        }
        return createCommandRef(intent, { activityId: intent.activityId, result: resolution.value })
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
        return createCommandRef(intent, { timerId: intent.timerId })
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
  }

  const queries: WorkflowQueries = {
    register(handle, resolver, options) {
      return queryRegistry.register(handle, resolver, options)
    },
    resolve(handle, input, metadata) {
      return queryRegistry.resolve(handle, input, metadata)
    },
  }

  const determinism: WorkflowDeterminismHelpers = {
    now: () => params.determinismGuard.nextTime(() => Date.now()),
    random: () => params.determinismGuard.nextRandom(() => Math.random()),
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
    continueAsNew(options) {
      return Effect.sync(() => {
        const intent = buildContinueAsNewIntent(commandContext, options)
        commandContext.addIntent(intent)
        return intent
      }).pipe(Effect.flatMap(() => Effect.fail(new ContinueAsNewWorkflowError())))
    },
  }

  return { context, commandContext, queryRegistry }
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
  return {
    id: `start-timer-${sequence}`,
    kind: 'start-timer',
    sequence,
    timerId: options.timerId ?? `timer-${sequence}`,
    timeoutMs: options.timeoutMs,
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
  ) {
    return Effect.suspend(() => {
      const entry = this.#shift(handle.name)
      if (!entry) {
        return Effect.fail(new WorkflowBlockedError(`Signal "${handle.name}" not yet delivered`))
      }
      const handlerName = resolveHandlerName(options?.name, handler, handle.name)
      return this.#decode(handle, entry)
        .pipe(Effect.tap((payload) => this.#record(handle.name, handlerName, payload, entry.metadata)))
        .pipe(Effect.flatMap((payload) => handler(payload, entry.metadata)))
    })
  }

  waitFor<I>(handle: WorkflowSignalHandle<I>, options?: WorkflowSignalHandlerOptions) {
    return Effect.suspend(() => {
      const entry = this.#shift(handle.name)
      if (!entry) {
        return Effect.fail(new WorkflowBlockedError(`Signal "${handle.name}" not yet delivered`))
      }
      const handlerName = options?.name ?? 'waitFor'
      return this.#decode(handle, entry)
        .pipe(Effect.tap((payload) => this.#record(handle.name, handlerName, payload, entry.metadata)))
        .pipe(Effect.map((payload) => ({ payload, metadata: entry.metadata }) as WorkflowSignalDelivery<I>))
    })
  }

  drain<I>(handle: WorkflowSignalHandle<I>, options?: WorkflowSignalHandlerOptions) {
    return Effect.suspend(() => {
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
    })
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
  ): Effect.Effect<O, WorkflowQueryHandlerMissingError, never> {
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
    const normalized = normalizeInboundArguments(request.args, entry.handle.decodeInputAsArray)
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

const resolveHandlerName = (
  configured: string | undefined,
  handler: WorkflowSignalHandler<unknown, void> | undefined,
  fallback: string,
): string => configured ?? handler?.name ?? fallback

const runSequential = <A>(
  entries: readonly SignalQueueEntry[],
  factory: (entry: SignalQueueEntry) => Effect.Effect<A, WorkflowBlockedError, never>,
): Effect.Effect<readonly A[], WorkflowBlockedError, never> =>
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
    Effect.succeed<readonly A[]>([]),
  )
