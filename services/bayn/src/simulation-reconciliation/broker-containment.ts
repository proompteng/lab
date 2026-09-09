import { Cause, Effect, Exit } from 'effect'

import { BrokerReadError } from '../broker/alpaca'
import type { ExecutionStoreError, ReconciliationPersistence } from '../db/execution-store'
import type { WriterFenceError, WriterFenceService } from '../execution/writer-fence'
import { ReconciliationError, incompletePassReason, type ReconciliationPassError } from './broker-reconciler-model'
import { Pipeable } from '../pipeable'

export type ContainmentDecision =
  | { readonly _tag: 'PreserveAuthority' }
  | { readonly _tag: 'RestrictAuthority'; readonly reason: typeof incompletePassReason }

const isRetryableBrokerReadFailure = (cause: Cause.Cause<ReconciliationPassError>): boolean =>
  cause.reasons.length > 0 &&
  cause.reasons.every(
    (reason) => Cause.isFailReason(reason) && reason.error instanceof BrokerReadError && reason.error.retryable,
  )

export const decideContainment = (cause: Cause.Cause<ReconciliationPassError>): ContainmentDecision =>
  Cause.hasInterruptsOnly(cause) || isRetryableBrokerReadFailure(cause)
    ? { _tag: 'PreserveAuthority' }
    : { _tag: 'RestrictAuthority', reason: incompletePassReason }

const restrictAuthority = (
  store: ReconciliationPersistence,
  fence: WriterFenceService,
  now: Effect.Effect<string>,
  decision: Extract<ContainmentDecision, { readonly _tag: 'RestrictAuthority' }>,
): Effect.Effect<void, ExecutionStoreError | WriterFenceError> =>
  now.pipe(
    Effect.flatMap((failedAt) =>
      fence.transaction(store.authorityRestriction.restrictAuthority(decision.reason, failedAt)),
    ),
  )

const hasDefectOrInterruption = <E>(cause: Cause.Cause<E>): boolean =>
  cause.reasons.some((reason) => Cause.isDieReason(reason) || Cause.isInterruptReason(reason))

const authorityRestrictionFailure = (
  reconciliationCause: Cause.Cause<ReconciliationPassError>,
  restrictionCause: Cause.Cause<ExecutionStoreError | WriterFenceError>,
): ReconciliationError =>
  new ReconciliationError({
    operation: 'containment',
    message: 'authority restriction failed after reconciliation failure',
    failure: { _tag: 'AuthorityRestrictionFailed', reconciliationCause, restrictionCause },
  })

const preserveFailureAfterContainment = (
  cause: Cause.Cause<ReconciliationPassError>,
  containmentExit: Exit.Exit<void, ExecutionStoreError | WriterFenceError>,
): Effect.Effect<never, ReconciliationPassError> => {
  if (Exit.isSuccess(containmentExit)) return Effect.failCause(cause)
  if (hasDefectOrInterruption(containmentExit.cause)) {
    return Effect.failCause(Cause.combine(cause, containmentExit.cause))
  }
  const containmentError = authorityRestrictionFailure(cause, containmentExit.cause)
  return hasDefectOrInterruption(cause)
    ? Effect.failCause(Cause.combine(cause, Cause.fail(containmentError)))
    : Effect.fail(containmentError)
}

const containRuntimeFailureDataFirst = <A, R>(
  effect: Effect.Effect<A, ReconciliationPassError, R>,
  store: ReconciliationPersistence,
  fence: WriterFenceService,
  now: Effect.Effect<string>,
): Effect.Effect<A, ReconciliationPassError, R> =>
  Effect.matchCauseEffect(effect, {
    onFailure: (cause) => {
      const decision = decideContainment(cause)
      if (decision._tag === 'PreserveAuthority') return Effect.failCause(cause)
      return Effect.exit(restrictAuthority(store, fence, now, decision)).pipe(
        Effect.flatMap((containmentExit) => preserveFailureAfterContainment(cause, containmentExit)),
      )
    },
    onSuccess: Effect.succeed,
  })

export const containRuntimeFailure = Pipeable.generic<
  <A, R>(
    store: ReconciliationPersistence,
    fence: WriterFenceService,
    now: Effect.Effect<string>,
  ) => (effect: Effect.Effect<A, ReconciliationPassError, R>) => Effect.Effect<A, ReconciliationPassError, R>,
  typeof containRuntimeFailureDataFirst
>(4, containRuntimeFailureDataFirst)
