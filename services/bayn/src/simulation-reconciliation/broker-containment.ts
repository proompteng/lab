import { Cause, Effect, Exit } from 'effect'

import type { ExecutionStoreError, ReconciliationPersistence } from '../db/execution-store'
import type { WriterFenceError, WriterFenceService } from '../execution/writer-fence'
import { ReconciliationError, incompletePassReason, type ReconciliationPassError } from './broker-reconciler-model'
import { Pipeable } from '../pipeable'

export type ContainmentDecision =
  | { readonly _tag: 'PreserveInterruption' }
  | { readonly _tag: 'RestrictAuthority'; readonly reason: typeof incompletePassReason }

export const decideContainment = <E>(cause: Cause.Cause<E>): ContainmentDecision =>
  Cause.hasInterruptsOnly(cause)
    ? { _tag: 'PreserveInterruption' }
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
      if (decision._tag === 'PreserveInterruption') return Effect.failCause(cause)
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
