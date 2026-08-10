import { Context, Data, Effect, Option, Result, Schema } from 'effect'
import { isSqlError, type SqlError } from 'effect/unstable/sql/SqlError'

import type { AutonomousCycle, CycleCompletionState, CycleDraft, CycleTerminalReason } from '../../cycle'
import type { CycleDecisionDocument } from '../../shadow-decision-contract'
import type { InputManifest, IsoDate } from '../../types'
import type { CycleStoreDecisionFailure } from './decision-contract'
import { Pipeable } from '../../pipeable'

export {
  attachCycleDecisionStoreEvidence,
  cycleDecisionStoreEvidence,
  type CycleDecisionStoreEvidence,
} from './decision-contract'

export interface CycleAcquireReceipt {
  readonly cycle: AutonomousCycle
  readonly created: boolean
}

export interface CycleMutationReceipt {
  readonly cycle: AutonomousCycle
  readonly changed: boolean
}

export interface CycleAuthoritySlot {
  readonly qualificationRunId: string
  readonly accountId: string
  readonly signalSessionDate: IsoDate
}

export interface CycleRecoveryScope {
  readonly qualificationRunId: string
  readonly accountId: string
}

export class CycleStoreError extends Data.TaggedError('CycleStoreError')<{
  readonly operation:
    | 'acquire'
    | 'activate'
    | 'bind-decision'
    | 'bind-snapshot'
    | 'block'
    | 'finish'
    | 'read'
    | 'read-authority-slot'
    | 'read-decision-document'
    | 'read-oldest-unfinished'
  readonly failure: 'conflict' | 'decode' | 'invariant' | 'not-found' | 'query'
  readonly persistenceFailure?: 'connectivity' | 'constraint' | 'decode' | 'invariant' | 'query' | 'transaction'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface CycleStoreShape {
  readonly acquire: (draft: CycleDraft, observedAt: string) => Effect.Effect<CycleAcquireReceipt, CycleStoreError>
  readonly read: (cycleId: string) => Effect.Effect<Option.Option<AutonomousCycle>, CycleStoreError>
  readonly readAuthoritySlot: (
    slot: CycleAuthoritySlot,
  ) => Effect.Effect<Option.Option<AutonomousCycle>, CycleStoreError>
  readonly readDecisionDocument: (
    cycleId: string,
  ) => Effect.Effect<Option.Option<CycleDecisionDocument>, CycleStoreError>
  readonly readOldestUnfinished: (
    scope: CycleRecoveryScope,
  ) => Effect.Effect<Option.Option<AutonomousCycle>, CycleStoreError>
  readonly bindSnapshot: (
    cycleId: string,
    inputManifest: InputManifest,
    observedAt: string,
  ) => Effect.Effect<CycleMutationReceipt, CycleStoreError>
  readonly activate: (cycleId: string, observedAt: string) => Effect.Effect<CycleMutationReceipt, CycleStoreError>
  readonly bindDecision: (
    cycleId: string,
    document: CycleDecisionDocument,
    observedAt: string,
  ) => Effect.Effect<CycleMutationReceipt, CycleStoreError>
  readonly finish: (
    cycleId: string,
    state: CycleCompletionState,
    observedAt: string,
  ) => Effect.Effect<CycleMutationReceipt, CycleStoreError>
  readonly block: (
    cycleId: string,
    reason: CycleTerminalReason,
    observedAt: string,
  ) => Effect.Effect<CycleMutationReceipt, CycleStoreError>
}

export class CycleStore extends Context.Service<CycleStore, CycleStoreShape>()(
  '@proompteng/bayn/db/cycle-store/model/CycleStore',
) {}

export type CycleStoreInternalError = CycleStoreError | Schema.SchemaError | SqlError

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const defaultPersistenceFailure = (
  failure: CycleStoreError['failure'],
): NonNullable<CycleStoreError['persistenceFailure']> => {
  switch (failure) {
    case 'conflict':
      return 'constraint'
    case 'decode':
      return 'decode'
    case 'query':
      return 'query'
    case 'invariant':
    case 'not-found':
      return 'invariant'
  }
}

export interface CycleStoreErrorInput {
  readonly operation: CycleStoreError['operation']
  readonly failure: CycleStoreError['failure']
  readonly message: string
  readonly cause?: unknown
  readonly persistenceFailure?: NonNullable<CycleStoreError['persistenceFailure']>
}

export const cycleStoreError = (input: CycleStoreErrorInput): CycleStoreError => {
  const { operation, failure, message, cause, persistenceFailure = defaultPersistenceFailure(failure) } = input
  return new CycleStoreError({
    operation,
    failure,
    persistenceFailure,
    message: cause === undefined ? message : `${message}: ${messageOf(cause)}`,
    cause,
  })
}

const runCycleStoreDataFirst = <A, E, R>(
  operation: CycleStoreError['operation'],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, CycleStoreError, R> =>
  effect.pipe(
    Effect.mapError((cause) => {
      if (cause instanceof CycleStoreError) return cause
      if (Schema.isSchemaError(cause)) {
        return cycleStoreError({
          operation,
          failure: 'decode',
          message: 'autonomous cycle contract decoding failed',
          cause,
        })
      }
      if (isSqlError(cause)) {
        const failure =
          cause.reason._tag === 'ConstraintError' || cause.reason._tag === 'UniqueViolation' ? 'conflict' : 'query'
        const persistenceFailure = (() => {
          switch (cause.reason._tag) {
            case 'AuthenticationError':
            case 'AuthorizationError':
            case 'ConnectionError':
            case 'UnknownError':
              return 'connectivity'
            case 'ConstraintError':
            case 'UniqueViolation':
              return 'constraint'
            case 'DeadlockError':
            case 'LockTimeoutError':
            case 'SerializationError':
            case 'StatementTimeoutError':
              return 'transaction'
            case 'SqlSyntaxError':
              return 'query'
          }
        })()
        return cycleStoreError({
          operation,
          failure,
          message: 'autonomous cycle PostgreSQL operation failed',
          cause,
          persistenceFailure,
        })
      }
      return cycleStoreError({
        operation,
        failure: 'invariant',
        message: 'autonomous cycle operation failed unexpectedly',
        cause,
      })
    }),
  )

export const runCycleStore = Pipeable.generic<
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => (operation: CycleStoreError['operation']) => Effect.Effect<A, CycleStoreError, R>,
  typeof runCycleStoreDataFirst
>(2, runCycleStoreDataFirst)

const failCycleStoreDataFirst = (
  operation: CycleStoreError['operation'],
  failure: CycleStoreError['failure'],
  message: string,
): Effect.Effect<never, CycleStoreError> => Effect.fail(cycleStoreError({ operation, failure, message }))

export const failCycleStore = Pipeable.dual(3, failCycleStoreDataFirst)

const liftCycleDecisionDataFirst = <A>(
  operation: CycleStoreError['operation'],
  decision: Result.Result<A, CycleStoreDecisionFailure>,
): Effect.Effect<A, CycleStoreError> =>
  Effect.fromResult(decision).pipe(
    Effect.mapError(({ failure, message }) => cycleStoreError({ operation, failure, message })),
  )

export const liftCycleDecision = Pipeable.generic<
  <A>(
    decision: Result.Result<A, CycleStoreDecisionFailure>,
  ) => (operation: CycleStoreError['operation']) => Effect.Effect<A, CycleStoreError>,
  typeof liftCycleDecisionDataFirst
>(2, liftCycleDecisionDataFirst)

const exactlyOneCycleDataFirst = (
  operation: CycleStoreError['operation'],
  rows: readonly AutonomousCycle[],
): Effect.Effect<AutonomousCycle, CycleStoreError> => {
  const cycle = rows[0]
  if (rows.length !== 1 || cycle === undefined) {
    return failCycleStore(
      operation,
      rows.length === 0 ? 'not-found' : 'invariant',
      'autonomous cycle was not found exactly once',
    )
  }
  return Effect.succeed(cycle)
}

export const exactlyOneCycle = Pipeable.dual(2, exactlyOneCycleDataFirst)
