import { Data, Result, Schema } from 'effect'

import type { AdvanceExecutionCommand } from './advance'
import { GitSourceRevisionSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'

const CounterSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const EpochSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))
const DelaySchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400_000 }))
const DeliveryAttemptSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))

export const ExecutionControllerActivationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-controller-activation.v1'),
  controllerKey: Sha256Schema,
  epoch: EpochSchema,
  firstSequence: CounterSchema,
  planHash: Sha256Schema,
  sourceRevision: GitSourceRevisionSchema,
})
export type ExecutionControllerActivation = typeof ExecutionControllerActivationSchema.Type

export const ExecutionControllerTickSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-controller-tick.v1'),
  epoch: EpochSchema,
  sequence: CounterSchema,
  attempt: Schema.optionalKey(DeliveryAttemptSchema),
  issuedAt: Schema.optionalKey(UtcInstantSchema),
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

const CompletionSchema = Schema.Struct({
  sequence: CounterSchema,
  outcome: Schema.Literals(['Completed', 'Blocked']),
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
})
export type ExecutionControllerState = typeof ExecutionControllerStateSchema.Type

export const ExecutionAdvanceStepResultSchema = Schema.Struct({
  completedAt: UtcInstantSchema,
  outcome: Schema.Struct({
    _tag: Schema.Literals(['Completed', 'Blocked']),
    receiptHash: Sha256Schema,
    nextDelayMs: DelaySchema,
  }),
})
export type ExecutionAdvanceStepResult = typeof ExecutionAdvanceStepResultSchema.Type

export class ExecutionControllerDecisionError extends Data.TaggedError('ExecutionControllerDecisionError')<{
  readonly operation: 'activate' | 'complete' | 'deactivate'
  readonly reason: 'conflict' | 'counter-exhausted' | 'invalid-time'
  readonly message: string
}> {}

export type ExecutionControllerActivationDecision =
  | { readonly _tag: 'Activated'; readonly state: ExecutionControllerState }
  | { readonly _tag: 'Replayed'; readonly state: ExecutionControllerState }

export type ExecutionControllerTickDecision =
  | { readonly _tag: 'Advance'; readonly command: AdvanceExecutionCommand }
  | { readonly _tag: 'Ignored'; readonly reason: 'Inactive' | 'StaleEpoch' | 'StaleSequence' }

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

export const decideExecutionControllerTick = (
  state: ExecutionControllerState | null,
  tick: ExecutionControllerTick,
  controllerKey: string,
  issuedAt: string,
): ExecutionControllerTickDecision => {
  if (state === null || !state.active) return { _tag: 'Ignored', reason: 'Inactive' }
  if (tick.epoch !== state.epoch) return { _tag: 'Ignored', reason: 'StaleEpoch' }
  if (tick.sequence !== state.nextSequence) return { _tag: 'Ignored', reason: 'StaleSequence' }
  return {
    _tag: 'Advance',
    command: {
      controllerKey,
      epoch: state.epoch,
      sequence: state.nextSequence,
      issuedAt,
      sourceRevision: state.sourceRevision,
    },
  }
}

export const completeExecutionControllerTick = (
  state: ExecutionControllerState,
  tick: ExecutionControllerTick,
  result: ExecutionAdvanceStepResult,
): Result.Result<ExecutionControllerState, ExecutionControllerDecisionError> => {
  if (!state.active || tick.epoch !== state.epoch || tick.sequence !== state.nextSequence) {
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
    try: () => new Date(Date.parse(result.completedAt) + result.outcome.nextDelayMs).toISOString(),
    catch: () =>
      new ExecutionControllerDecisionError({
        operation: 'complete',
        reason: 'invalid-time',
        message: 'execution controller next due time could not be represented',
      }),
  })
  if (Result.isFailure(nextDueAt)) return Result.fail(nextDueAt.failure)
  return Result.succeed({
    ...state,
    nextSequence: state.nextSequence + 1,
    lastCompletion: {
      sequence: tick.sequence,
      outcome: result.outcome._tag,
      receiptHash: result.outcome.receiptHash,
      completedAt: result.completedAt,
    },
    nextDueAt: nextDueAt.success,
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

export const decodeExecutionControllerActivation = Schema.decodeUnknownResult(
  ExecutionControllerActivationSchema,
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
