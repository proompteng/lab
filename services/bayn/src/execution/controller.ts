import { Data, Result, Schema } from 'effect'

import type { AdvanceExecutionCommand } from './advance'
import { ExecutionControllerOutcome } from './controller-status'
import { JevInferenceJobSchema } from '../jev/inference-work'
import { RetainedAutonomousCyclePassObservationSchema } from '../cycle/runner/pass-observation'
import { GitSourceRevisionSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'

const CounterSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const EpochSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))
const DelaySchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400_000 }))
// Replacement workers may briefly wait for the Restate operator to terminate the predecessor and release its
// process-scoped PostgreSQL writer fence. Keep enough durable delivery identities for that bounded handoff window.
export const executionControllerMaximumDeliveryAttempt = 6
const DeliveryAttemptSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: executionControllerMaximumDeliveryAttempt }),
)
export const executionControllerMaximumRecoveryWindow = 7
/** The counter saturates; a failed owner must keep its bounded recovery cadence alive. */
export const nextExecutionControllerRecoveryWindow = (current: number): number =>
  Math.min(current + 1, executionControllerMaximumRecoveryWindow)

const RecoveryWindowSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: executionControllerMaximumRecoveryWindow }),
)
const decodeUtcInstant = Schema.decodeUnknownResult(UtcInstantSchema, strictParseOptions)

export const ExecutionControllerActivationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-controller-activation.v1'),
  controllerKey: Sha256Schema,
  epoch: EpochSchema,
  firstSequence: CounterSchema,
  planHash: Sha256Schema,
  sourceRevision: GitSourceRevisionSchema,
})
export type ExecutionControllerActivation = typeof ExecutionControllerActivationSchema.Type

export const ExecutionDeploymentActivationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-deployment-activation.v2'),
  controllerKey: Sha256Schema,
  planHash: Sha256Schema,
  sourceRevision: GitSourceRevisionSchema,
})
export type ExecutionDeploymentActivation = typeof ExecutionDeploymentActivationSchema.Type

export const ExecutionControllerTickSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-controller-tick.v1'),
  epoch: EpochSchema,
  sequence: CounterSchema,
  attempt: Schema.optionalKey(DeliveryAttemptSchema),
  issuedAt: Schema.optionalKey(UtcInstantSchema),
  recoveryWindow: Schema.optionalKey(RecoveryWindowSchema),
  retryWindowHash: Schema.optionalKey(Sha256Schema),
  sourceCatchUpRevision: Schema.optionalKey(GitSourceRevisionSchema),
})
export type ExecutionControllerTick = typeof ExecutionControllerTickSchema.Type

export const ExecutionControllerDeactivationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-controller-deactivation.v1'),
  controllerKey: Sha256Schema,
  epoch: EpochSchema,
  planHash: Sha256Schema,
  sourceRevision: GitSourceRevisionSchema,
})
export type ExecutionControllerDeactivation = typeof ExecutionControllerDeactivationSchema.Type

export const ExecutionControllerRotationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-controller-rotation.v1'),
  deployment: ExecutionDeploymentActivationSchema,
  predecessor: ExecutionControllerDeactivationSchema,
})
export type ExecutionControllerRotation = typeof ExecutionControllerRotationSchema.Type

const CompletionSchema = Schema.Struct({
  sequence: CounterSchema,
  outcome: Schema.Enum(ExecutionControllerOutcome),
  receiptHash: Sha256Schema,
  completedAt: UtcInstantSchema,
})

export const ExecutionControllerStateSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  active: Schema.Boolean,
  epoch: EpochSchema,
  planHash: Sha256Schema,
  sourceRevision: GitSourceRevisionSchema,
  initialSequence: CounterSchema,
  nextSequence: CounterSchema,
  lastCompletion: Schema.optionalKey(CompletionSchema),
  nextDueAt: Schema.optionalKey(UtcInstantSchema),
  marketEligibleAt: Schema.optionalKey(UtcInstantSchema),
  wakeScheduledSequence: Schema.optionalKey(CounterSchema),
  wakeAcceptedAt: Schema.optionalKey(UtcInstantSchema),
  marketFrontier: Schema.optionalKey(
    Schema.Struct({
      producerId: Schema.String.check(Schema.isUUID(4)),
      sequence: EpochSchema,
    }),
  ),
  lastBrokerSnapshotHash: Schema.optionalKey(Sha256Schema),
})
export type ExecutionControllerState = typeof ExecutionControllerStateSchema.Type

export const ExecutionAdvanceStepResultSchema = Schema.Struct({
  completedAt: UtcInstantSchema,
  observation: Schema.optionalKey(RetainedAutonomousCyclePassObservationSchema),
  inferenceJobs: Schema.optionalKey(Schema.Array(JevInferenceJobSchema)),
  outcome: Schema.Struct({
    _tag: Schema.Enum(ExecutionControllerOutcome),
    receiptHash: Sha256Schema,
    nextDelayMs: DelaySchema,
    nextWakeAt: Schema.optionalKey(UtcInstantSchema),
  }),
})
export type ExecutionAdvanceStepResult = typeof ExecutionAdvanceStepResultSchema.Type

export class ExecutionControllerDecisionError extends Data.TaggedError('ExecutionControllerDecisionError')<{
  readonly operation: 'activate' | 'complete' | 'deactivate' | 'tick'
  readonly reason: 'conflict' | 'counter-exhausted' | 'invalid-time'
  readonly message: string
}> {}

export type ExecutionControllerActivationDecision =
  | { readonly _tag: 'Activated'; readonly state: ExecutionControllerState }
  | { readonly _tag: 'Replayed'; readonly state: ExecutionControllerState }

export type ExecutionControllerTickDecision =
  | { readonly _tag: 'Advance'; readonly command: Omit<AdvanceExecutionCommand, 'issuedAt'> }
  | { readonly _tag: 'Ignored'; readonly reason: 'Inactive' | 'StaleEpoch' | 'StaleSequence' }

export type ExecutionDeploymentActivationDecision =
  | {
      readonly _tag: 'Activate'
      readonly state: ExecutionControllerState | null
    }
  | {
      readonly _tag: 'Rotate'
      readonly deactivation: ExecutionControllerDeactivation
    }

const sameBinding = (
  state: ExecutionControllerState,
  request: Pick<ExecutionControllerActivation, 'planHash' | 'sourceRevision'>,
): boolean => state.planHash === request.planHash && state.sourceRevision === request.sourceRevision

const conflict = (
  operation: ExecutionControllerDecisionError['operation'],
  message: string,
): Result.Result<never, ExecutionControllerDecisionError> =>
  Result.fail(new ExecutionControllerDecisionError({ operation, reason: 'conflict', message }))

export const decideExecutionControllerActivation = (
  state: ExecutionControllerState | null,
  request: ExecutionControllerActivation,
): Result.Result<ExecutionControllerActivationDecision, ExecutionControllerDecisionError> => {
  if (request.epoch === Number.MAX_SAFE_INTEGER) {
    return Result.fail(
      new ExecutionControllerDecisionError({
        operation: 'activate',
        reason: 'counter-exhausted',
        message: 'execution controller epoch is exhausted before activation',
      }),
    )
  }
  if (state === null) {
    return Result.succeed({
      _tag: 'Activated',
      state: {
        schemaVersion: 1,
        active: true,
        epoch: request.epoch,
        planHash: request.planHash,
        sourceRevision: request.sourceRevision,
        initialSequence: request.firstSequence,
        nextSequence: request.firstSequence,
      },
    })
  }
  if (
    state.active &&
    state.epoch === request.epoch &&
    state.initialSequence === request.firstSequence &&
    sameBinding(state, request)
  ) {
    return Result.succeed({ _tag: 'Replayed', state })
  }
  if (!state.active && request.epoch === state.epoch) {
    return Result.succeed({
      _tag: 'Activated',
      state: {
        schemaVersion: 1,
        active: true,
        epoch: request.epoch,
        planHash: request.planHash,
        sourceRevision: request.sourceRevision,
        initialSequence: request.firstSequence,
        nextSequence: request.firstSequence,
      },
    })
  }
  return conflict('activate', 'execution controller activation conflicts with durable controller state')
}

export const decideExecutionDeploymentActivation = (
  state: ExecutionControllerState | null,
  request: ExecutionDeploymentActivation,
): Result.Result<ExecutionDeploymentActivationDecision, ExecutionControllerDecisionError> => {
  if (state === null || sameBinding(state, request) || !state.active) {
    return Result.succeed({ _tag: 'Activate', state })
  }
  return Result.succeed({
    _tag: 'Rotate',
    deactivation: {
      schemaVersion: 'bayn.execution-controller-deactivation.v1',
      controllerKey: request.controllerKey,
      epoch: state.epoch,
      planHash: state.planHash,
      sourceRevision: state.sourceRevision,
    },
  })
}

export const decideExecutionControllerTick = (
  state: ExecutionControllerState | null,
  tick: ExecutionControllerTick,
  controllerKey: string,
  workerSourceRevision: string,
): Result.Result<ExecutionControllerTickDecision, ExecutionControllerDecisionError> => {
  if (state === null || !state.active) return Result.succeed({ _tag: 'Ignored', reason: 'Inactive' })
  if (tick.epoch !== state.epoch) return Result.succeed({ _tag: 'Ignored', reason: 'StaleEpoch' })
  if (tick.sequence !== state.nextSequence) return Result.succeed({ _tag: 'Ignored', reason: 'StaleSequence' })
  if (state.sourceRevision !== workerSourceRevision)
    return conflict('tick', 'execution controller worker does not own the active source')
  if (state.nextSequence === Number.MAX_SAFE_INTEGER) {
    return Result.fail(
      new ExecutionControllerDecisionError({
        operation: 'tick',
        reason: 'counter-exhausted',
        message: 'execution controller sequence is exhausted before advance',
      }),
    )
  }
  return Result.succeed({
    _tag: 'Advance',
    command: {
      controllerKey,
      epoch: state.epoch,
      sequence: state.nextSequence,
      sourceRevision: workerSourceRevision,
    },
  })
}

export const completeExecutionControllerTick = (
  state: ExecutionControllerState,
  tick: ExecutionControllerTick,
  result: ExecutionAdvanceStepResult,
  workerSourceRevision: string,
): Result.Result<ExecutionControllerState, ExecutionControllerDecisionError> => {
  if (
    !state.active ||
    tick.epoch !== state.epoch ||
    tick.sequence !== state.nextSequence ||
    state.sourceRevision !== workerSourceRevision
  ) {
    return conflict('complete', 'execution controller completion does not match durable controller state')
  }
  if (state.nextSequence === Number.MAX_SAFE_INTEGER) {
    return Result.fail(
      new ExecutionControllerDecisionError({
        operation: 'complete',
        reason: 'counter-exhausted',
        message: 'execution controller sequence is exhausted',
      }),
    )
  }
  const nextDueAt = Result.try({
    try: () => {
      if (result.outcome.nextWakeAt === undefined) return undefined
      return new Date(Date.parse(result.outcome.nextWakeAt)).toISOString()
    },
    catch: () =>
      new ExecutionControllerDecisionError({
        operation: 'complete',
        reason: 'invalid-time',
        message: 'execution controller next due time could not be represented',
      }),
  })
  if (Result.isFailure(nextDueAt)) return Result.fail(nextDueAt.failure)
  const decodedNextDueAt =
    nextDueAt.success === undefined ? Result.succeed(undefined) : decodeUtcInstant(nextDueAt.success)
  if (Result.isFailure(decodedNextDueAt)) {
    return Result.fail(
      new ExecutionControllerDecisionError({
        operation: 'complete',
        reason: 'invalid-time',
        message: 'execution controller next due time is outside the canonical UTC range',
      }),
    )
  }
  const {
    nextDueAt: _previousDeadline,
    marketEligibleAt: _previousEligibility,
    wakeScheduledSequence: _previousWake,
    wakeAcceptedAt: _previousWakeAcceptedAt,
    ...completedState
  } = state
  const availableAt =
    result.observation?.result !== 'SUCCESS'
      ? undefined
      : result.observation.outcome === 'WINDOW_CLOSED'
        ? result.outcome.nextWakeAt
        : result.observation.readiness?.availableAt
  return Result.succeed({
    ...completedState,
    nextSequence: state.nextSequence + 1,
    lastCompletion: {
      sequence: tick.sequence,
      outcome: result.outcome._tag,
      receiptHash: result.outcome.receiptHash,
      completedAt: result.completedAt,
    },
    ...(decodedNextDueAt.success === undefined ? {} : { nextDueAt: decodedNextDueAt.success }),
    ...(availableAt !== undefined && availableAt > result.completedAt ? { marketEligibleAt: availableAt } : {}),
  })
}

export type ExecutionControllerDeactivationDecision =
  | { readonly _tag: 'Deactivated'; readonly state: ExecutionControllerState }
  | { readonly _tag: 'Replayed'; readonly state: ExecutionControllerState }

export const decideExecutionControllerDeactivation = (
  state: ExecutionControllerState | null,
  request: ExecutionControllerDeactivation,
): Result.Result<ExecutionControllerDeactivationDecision, ExecutionControllerDecisionError> => {
  if (state === null) return conflict('deactivate', 'execution controller has no durable state')
  if (
    !state.active &&
    state.epoch === request.epoch + 1 &&
    state.planHash === request.planHash &&
    state.sourceRevision === request.sourceRevision
  ) {
    return Result.succeed({ _tag: 'Replayed', state })
  }
  if (
    !state.active ||
    state.epoch !== request.epoch ||
    state.planHash !== request.planHash ||
    state.sourceRevision !== request.sourceRevision
  ) {
    return conflict('deactivate', 'execution controller deactivation conflicts with durable controller state')
  }
  if (state.epoch === Number.MAX_SAFE_INTEGER) {
    return Result.fail(
      new ExecutionControllerDecisionError({
        operation: 'deactivate',
        reason: 'counter-exhausted',
        message: 'execution controller epoch is exhausted',
      }),
    )
  }
  const { nextDueAt: _nextDueAt, ...inactiveState } = state
  return Result.succeed({
    _tag: 'Deactivated',
    state: {
      ...inactiveState,
      active: false,
      epoch: state.epoch + 1,
    },
  })
}

export const decideExecutionControllerRotation = (
  state: ExecutionControllerState | null,
  request: ExecutionControllerRotation,
): Result.Result<ExecutionControllerActivationDecision, ExecutionControllerDecisionError> => {
  if (request.deployment.controllerKey !== request.predecessor.controllerKey)
    return conflict('activate', 'execution controller rotation account bindings differ')
  if (
    state !== null &&
    state.active &&
    state.epoch === request.predecessor.epoch + 1 &&
    sameBinding(state, request.deployment)
  )
    return Result.succeed({ _tag: 'Replayed', state })
  if (state === null || !state.active)
    return conflict('activate', 'execution controller rotation cannot resume a deactivated predecessor')
  // Derive the existing fenced transition without ever persisting its inactive intermediate state.
  return Result.flatMap(decideExecutionControllerDeactivation(state, request.predecessor), ({ state: inactive }) =>
    decideExecutionControllerActivation(inactive, {
      schemaVersion: 'bayn.execution-controller-activation.v1',
      controllerKey: request.deployment.controllerKey,
      epoch: inactive.epoch,
      firstSequence: inactive.nextSequence,
      planHash: request.deployment.planHash,
      sourceRevision: request.deployment.sourceRevision,
    }),
  )
}

export const decodeExecutionControllerActivation = Schema.decodeUnknownResult(
  ExecutionControllerActivationSchema,
  strictParseOptions,
)
export const decodeExecutionControllerRotation = Schema.decodeUnknownResult(
  ExecutionControllerRotationSchema,
  strictParseOptions,
)
export const decodeExecutionDeploymentActivation = Schema.decodeUnknownResult(
  ExecutionDeploymentActivationSchema,
  strictParseOptions,
)
export const decodeExecutionControllerTick = Schema.decodeUnknownResult(
  ExecutionControllerTickSchema,
  strictParseOptions,
)
export const decodeExecutionControllerDeactivation = Schema.decodeUnknownResult(
  ExecutionControllerDeactivationSchema,
  strictParseOptions,
)
export const decodeExecutionControllerState = Schema.decodeUnknownResult(
  ExecutionControllerStateSchema,
  strictParseOptions,
)
export const decodeExecutionAdvanceStepResult = Schema.decodeUnknownResult(
  ExecutionAdvanceStepResultSchema,
  strictParseOptions,
)

export const executionControllerSuccessorPassCompleted = (
  state: ExecutionControllerState | null,
  activation: Pick<ExecutionControllerActivation, 'epoch' | 'firstSequence' | 'planHash' | 'sourceRevision'>,
): state is ExecutionControllerState & {
  readonly lastCompletion: NonNullable<ExecutionControllerState['lastCompletion']>
} =>
  state !== null &&
  state.active &&
  state.epoch === activation.epoch &&
  state.planHash === activation.planHash &&
  state.sourceRevision === activation.sourceRevision &&
  state.lastCompletion !== undefined &&
  state.lastCompletion.sequence >= activation.firstSequence &&
  state.nextSequence === state.lastCompletion.sequence + 1
