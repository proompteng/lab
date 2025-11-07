import { Effect } from 'effect'

import type {
  ContinueAsNewWorkflowCommandIntent,
  ScheduleActivityCommandIntent,
  SignalExternalWorkflowCommandIntent,
  StartChildWorkflowCommandIntent,
  StartTimerCommandIntent,
  WorkflowCommandIntent,
} from './commands'
import type { DeterminismGuard, WorkflowRetryPolicyInput } from './determinism'
import { ContinueAsNewWorkflowError, WorkflowBlockedError } from './errors'

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
}

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

  addIntent(intent: WorkflowCommandIntent): void {
    this.#guard.recordCommand(intent)
    this.#intents.push(intent)
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
): { context: WorkflowContext<I>; commandContext: WorkflowCommandContext } => {
  const commandContext = new WorkflowCommandContext({ info: params.info, guard: params.determinismGuard })

  const activities: WorkflowActivities = {
    schedule(activityType, args = [], options = {}) {
      return Effect.sync(() => {
        const intent = buildScheduleActivityIntent(commandContext, activityType, args, options)
        commandContext.addIntent(intent)
        return createCommandRef(intent, { activityId: intent.activityId })
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
    determinism,
    continueAsNew(options) {
      return Effect.sync(() => {
        const intent = buildContinueAsNewIntent(commandContext, options)
        commandContext.addIntent(intent)
        return intent
      }).pipe(Effect.flatMap(() => Effect.fail(new ContinueAsNewWorkflowError())))
    },
  }

  return { context, commandContext }
}

const createCommandRef = (
  intent: WorkflowCommandIntent,
  extras?: Partial<Pick<WorkflowScheduledCommandRef, 'activityId' | 'timerId'>>,
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
