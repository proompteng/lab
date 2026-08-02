import { Effect } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations'
import type { MutationEvent } from '../execution/mutations'
import {
  completePaperProofReceipt,
  completeRecovery,
  completionMatchesAuthoritativeMutation,
  decideRecoverySelection,
  isCancellationSettled,
  isRecoveredCancellation,
  isTerminalSubmit,
  loadRecoveryCompletion,
  loadRecoveryRequired,
  makeReceiptFromCompletion,
  markRecoveryRequired,
  observeReconciliation,
  persistRecoveryCompletion,
  readDurableMutationState,
  readPaperProofIntent,
  readPaperProofMutation,
  recoverMutationLookup,
  reconcileExact,
  restrictPaperProof,
  validateCompletionMutationIdentity,
  type DurableMutationState,
  type PaperProofMutationStore,
  type PaperProofOperationContext,
  type PaperProofRestrictionDependencies,
} from './operations'
import type {
  PaperProofError,
  PaperProofIntentSnapshot,
  PaperProofReceipt,
  PaperProofReconciliation,
  PaperProofRecoveryCompletion,
  PaperProofRecoveryStore,
} from './model'

export interface PaperProofRecoverDependencies extends PaperProofRestrictionDependencies {
  readonly recovery: PaperProofRecoveryStore
  readonly mutations: PaperProofMutationStore
  readonly execution: {
    /** Lookup-only recovery for a previously started SUBMIT. It never issues another POST. */
    readonly recoverSubmit: (intentId: string) => Effect.Effect<MutationEvent, Error>
    /** Lookup-only recovery for a previously started CANCEL. It never issues another DELETE. */
    readonly recoverCancel: (intentId: string) => Effect.Effect<MutationEvent, Error>
  }
  readonly readIntent: (intentId: string) => Effect.Effect<PaperProofIntentSnapshot | undefined, Error>
  readonly reconcile: () => Effect.Effect<PaperProofReconciliation, Error>
}

const cancellationTerminal = (
  context: PaperProofOperationContext<'RECOVER'>,
  dependencies: PaperProofRecoverDependencies,
  event: MutationEvent,
): Effect.Effect<boolean, PaperProofError> =>
  isRecoveredCancellation(event)
    ? readPaperProofIntent(context, 'RECOVER', dependencies.readIntent).pipe(
        Effect.map((intent) => isCancellationSettled(event, intent)),
      )
    : Effect.succeed(false)

const latestCancellation =
  (
    context: PaperProofOperationContext<'RECOVER'>,
    dependencies: PaperProofRecoverDependencies,
  ): (() => Effect.Effect<MutationEvent | undefined, PaperProofError>) =>
  () =>
    readPaperProofMutation(context, 'RECOVERY_STATE', dependencies.mutations, MutationOperation.Cancel)

const recoverAuthoritativeMutation = (
  context: PaperProofOperationContext<'RECOVER'>,
  dependencies: PaperProofRecoverDependencies,
  operation: 'SUBMIT' | 'CANCEL',
  recorded: MutationEvent,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    const alreadySettled =
      operation === 'CANCEL' ? yield* cancellationTerminal(context, dependencies, recorded) : isTerminalSubmit(recorded)
    if (alreadySettled) {
      const reconciliation = yield* reconcileExact(context.sourcePlan.accountId, dependencies.reconcile)
      const receipt = yield* completePaperProofReceipt(context, dependencies.currentUtcInstant, {
        mutation: recorded,
        reconciliations: [reconciliation],
        restricted: true,
        recoveryRequired: false,
      })
      yield* persistRecoveryCompletion(
        context,
        {
          recovery: dependencies.recovery,
          ...(operation === 'SUBMIT' ? { latestCancellation: latestCancellation(context, dependencies) } : {}),
        },
        operation,
        receipt,
      )
      return receipt
    }

    const before = yield* observeReconciliation(context.sourcePlan.accountId, dependencies.reconcile)
    const event =
      operation === 'SUBMIT'
        ? yield* recoverMutationLookup(context, MutationOperation.Submit, () =>
            dependencies.execution.recoverSubmit(context.sourcePlan.intentId),
          )
        : yield* recoverMutationLookup(context, MutationOperation.Cancel, () =>
            dependencies.execution.recoverCancel(context.sourcePlan.intentId),
          )
    const settled =
      operation === 'CANCEL' ? yield* cancellationTerminal(context, dependencies, event) : isTerminalSubmit(event)
    const after = settled
      ? yield* reconcileExact(context.sourcePlan.accountId, dependencies.reconcile)
      : yield* observeReconciliation(context.sourcePlan.accountId, dependencies.reconcile)
    const receipt = yield* completePaperProofReceipt(context, dependencies.currentUtcInstant, {
      mutation: event,
      reconciliations: [before, after],
      restricted: true,
      recoveryRequired: !settled,
    })
    if (settled) {
      yield* persistRecoveryCompletion(
        context,
        {
          recovery: dependencies.recovery,
          ...(operation === 'SUBMIT' ? { latestCancellation: latestCancellation(context, dependencies) } : {}),
        },
        operation,
        receipt,
      )
    }
    return receipt
  })

const refreshCompletionAfterContainment = (
  context: PaperProofOperationContext<'RECOVER'>,
  dependencies: PaperProofRecoverDependencies,
  completion: PaperProofRecoveryCompletion,
): Effect.Effect<PaperProofRecoveryCompletion, PaperProofError> => {
  if (completion.restricted) return Effect.succeed(completion)
  return Effect.gen(function* () {
    const reconciliation = yield* reconcileExact(context.sourcePlan.accountId, dependencies.reconcile)
    const refreshed: PaperProofRecoveryCompletion = {
      ...completion,
      reconciliations: [...completion.reconciliations, reconciliation],
      restricted: true,
    }
    yield* completeRecovery(
      context,
      dependencies.recovery,
      completion.operation === 'SUBMIT' ? latestCancellation(context, dependencies) : undefined,
      refreshed,
    )
    return refreshed
  })
}

export const runPaperProofRecover = (
  context: PaperProofOperationContext<'RECOVER'>,
  dependencies: PaperProofRecoverDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    yield* restrictPaperProof(dependencies, 'paper-proof-recover-before-state-load')
    const completed = yield* loadRecoveryCompletion(context, dependencies.recovery)
    const required = yield* loadRecoveryRequired(context, dependencies.recovery)
    const mutations: DurableMutationState = yield* readDurableMutationState(context, 'RECOVER', dependencies.mutations)
    if (completed !== undefined && required === undefined) {
      yield* Effect.fromResult(
        // Completion is advisory until its mutation and authority facts are read again in this same pass.
        validateCompletionMutationIdentity(context, completed),
      )
      if (completionMatchesAuthoritativeMutation(mutations, completed)) {
        const settled =
          completed.operation === 'CANCEL'
            ? yield* cancellationTerminal(context, dependencies, completed.mutation)
            : isTerminalSubmit(completed.mutation)
        if (settled) {
          const refreshed = yield* refreshCompletionAfterContainment(context, dependencies, completed)
          return makeReceiptFromCompletion(context, refreshed)
        }
      }
    }

    const selection = yield* Effect.fromResult(decideRecoverySelection(mutations, required))
    if (required?.operation !== selection.operation) {
      yield* markRecoveryRequired(context, dependencies, selection.operation, 'paper-proof-reconstructed-recovery')
    }
    return yield* recoverAuthoritativeMutation(context, dependencies, selection.operation, selection.recorded)
  })
