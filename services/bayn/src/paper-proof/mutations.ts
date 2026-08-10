import { Effect } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations'
import type { CapitalGrantProofBinding } from '../execution/contracts'
import type { MutationEvent } from '../execution/mutations'
import {
  completePaperProofReceipt,
  decideCancellationAdmission,
  decideSubmitAdmission,
  ensureRecoveryMarkerCompatible,
  isCancellationSettled,
  isRecoveredCancellation,
  isSuccessfulSubmit,
  isTerminalSubmit,
  lift,
  markRecoveryRequired,
  observeReconciliation,
  paperProofFailure,
  persistRecoveryCompletion,
  readPaperProofIntent,
  readPaperProofMutation,
  recoverMutationLookup,
  reconcileExact,
  restrictPaperProof,
  validateExactReconciliation,
  type PaperProofExecutionHook,
  type PaperProofMutationRecoveryStore,
  type PaperProofMutationStore,
  type PaperProofOperationContext,
  type PaperProofReceiptFields,
  type PaperProofRestrictionDependencies,
} from './operations'
import { proofBinding } from './model'
import type {
  PaperProofError,
  PaperProofIntentSnapshot,
  PaperProofReceipt,
  PaperProofReconciliation,
  PaperProofRecoveryRequired,
  PreparedPaperProofIntent,
} from './model'
import { Pipeable } from '../pipeable'

export interface PaperProofSubmitDependencies extends PaperProofRestrictionDependencies {
  readonly activateCapitalGrant: (proof: CapitalGrantProofBinding) => Effect.Effect<void, Error>
  readonly recovery: PaperProofMutationRecoveryStore
  readonly mutations: PaperProofMutationStore
  readonly execution: {
    /** Lookup-only recovery for a previously started SUBMIT. It never issues another POST. */
    readonly recover: (intentId: string) => Effect.Effect<MutationEvent, Error>
    /** The adapter must run the containment hook exactly once immediately before the broker POST. */
    readonly submit: (
      intentId: string,
      consistencyDelayMs: number,
      beforeBrokerMutation: PaperProofExecutionHook,
    ) => Effect.Effect<MutationEvent, Error>
  }
  readonly prepareIntent: Effect.Effect<PreparedPaperProofIntent, Error>
  readonly reconcile: Effect.Effect<PaperProofReconciliation, Error>
}

export interface PaperProofCancelDependencies extends PaperProofRestrictionDependencies {
  readonly recovery: PaperProofMutationRecoveryStore
  readonly mutations: PaperProofMutationStore
  readonly execution: {
    /** Lookup-only recovery for a previously started CANCEL. It never issues another DELETE. */
    readonly recover: (intentId: string) => Effect.Effect<MutationEvent, Error>
    /** The adapter must run the containment hook exactly once immediately before the broker DELETE. */
    readonly cancel: (
      intentId: string,
      consistencyDelayMs: number,
      beforeBrokerMutation: PaperProofExecutionHook,
    ) => Effect.Effect<MutationEvent, Error>
  }
  readonly readIntent: (intentId: string) => Effect.Effect<PaperProofIntentSnapshot | undefined, Error>
  readonly reconcile: Effect.Effect<PaperProofReconciliation, Error>
}

const prepareSubmitIntent = (
  context: PaperProofOperationContext,
  dependencies: PaperProofSubmitDependencies,
): Effect.Effect<PreparedPaperProofIntent, PaperProofError> =>
  lift('SUBMIT', 'paper proof intent preparation failed', dependencies.prepareIntent).pipe(
    Effect.flatMap((prepared) =>
      prepared.intentId === context.sourcePlan.intentId
        ? Effect.succeed(prepared)
        : Effect.fail(
            paperProofFailure(
              'SUBMIT',
              'prepared PAPER intent identity does not match the source-controlled proof plan',
              prepared,
              'invariant',
            ),
          ),
    ),
  )

const prepareCancellation = (
  context: PaperProofOperationContext,
  dependencies: PaperProofCancelDependencies,
): Effect.Effect<{ readonly existing?: MutationEvent }, PaperProofError> =>
  Effect.gen(function* () {
    const existing = yield* readPaperProofMutation(context, 'CANCEL', dependencies.mutations, MutationOperation.Cancel)
    if (existing !== undefined) return { existing }

    const submitted = yield* readPaperProofMutation(context, 'CANCEL', dependencies.mutations, MutationOperation.Submit)
    if (submitted === undefined || !isSuccessfulSubmit(submitted) || submitted.brokerOrderId === undefined) {
      return yield* Effect.fromResult(decideCancellationAdmission(existing, submitted, undefined)).pipe(
        Effect.map(() => ({})),
      )
    }
    const intent = yield* readPaperProofIntent(context, 'CANCEL', dependencies.readIntent)
    return yield* Effect.fromResult(decideCancellationAdmission(existing, submitted, intent)).pipe(
      Effect.map(() => ({})),
    )
  })

const settleSubmitReceipt = (
  context: PaperProofOperationContext,
  dependencies: PaperProofSubmitDependencies,
  input: PaperProofReceiptFields,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    const receipt = yield* completePaperProofReceipt(context, dependencies.currentUtcInstant, input)
    if (!receipt.recoveryRequired) {
      yield* persistRecoveryCompletion(
        context,
        {
          recovery: dependencies.recovery,
          latestCancellation: () =>
            readPaperProofMutation(context, 'RECOVERY_STATE', dependencies.mutations, MutationOperation.Cancel),
        },
        'SUBMIT',
        receipt,
      )
    }
    return receipt
  })

const runExistingSubmit = (
  context: PaperProofOperationContext<'SUBMIT'>,
  dependencies: PaperProofSubmitDependencies,
  prepared: PreparedPaperProofIntent,
  before: PaperProofReconciliation,
  existing: MutationEvent,
  existingMarker: PaperProofRecoveryRequired | undefined,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    if (!isTerminalSubmit(existing)) {
      yield* markRecoveryRequired(context, dependencies, 'SUBMIT', 'paper-proof-existing-submit')
    }
    const event = isTerminalSubmit(existing)
      ? existing
      : yield* recoverMutationLookup(context, MutationOperation.Submit, () =>
          dependencies.execution.recover(context.sourcePlan.intentId),
        )
    let restricted = false
    if (!isSuccessfulSubmit(event)) {
      yield* restrictPaperProof(dependencies, `paper-proof-submit-${event.eventType.toLowerCase()}`)
      restricted = true
    }
    const finalReconciliation = isTerminalSubmit(event)
      ? yield* reconcileExact(context.sourcePlan.accountId, dependencies.reconcile)
      : yield* observeReconciliation(context.sourcePlan.accountId, dependencies.reconcile)
    const input: PaperProofReceiptFields = {
      clientOrderId: prepared.clientOrderId,
      mutation: event,
      reconciliations: [before, finalReconciliation],
      restricted,
      recoveryRequired: !isTerminalSubmit(event),
    }
    return isTerminalSubmit(existing) && existingMarker === undefined
      ? yield* completePaperProofReceipt(context, dependencies.currentUtcInstant, input)
      : yield* settleSubmitReceipt(context, dependencies, input)
  })

const runNewSubmit = (
  context: PaperProofOperationContext<'SUBMIT'>,
  dependencies: PaperProofSubmitDependencies,
  prepared: PreparedPaperProofIntent,
  before: PaperProofReconciliation,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    yield* Effect.fromResult(
      // The preflight reconciliation is also checked after activation so the broker hook cannot run on stale state.
      validateExactReconciliation(before),
    )
    yield* lift(
      'SUBMIT',
      'paper proof generation activation failed',
      dependencies.activateCapitalGrant(proofBinding(context.command)),
    )
    const afterActivation = yield* reconcileExact(context.sourcePlan.accountId, dependencies.reconcile)
    const event = yield* lift(
      'SUBMIT',
      'paper proof guarded submit failed',
      dependencies.execution.submit(prepared.intentId, context.command.consistencyDelayMs, () =>
        markRecoveryRequired(context, dependencies, 'SUBMIT', 'paper-proof-new-submit'),
      ),
    )
    let restricted = false
    if (!isSuccessfulSubmit(event)) {
      yield* restrictPaperProof(dependencies, `paper-proof-submit-${event.eventType.toLowerCase()}`)
      restricted = true
    }
    const finalReconciliation = isTerminalSubmit(event)
      ? yield* reconcileExact(context.sourcePlan.accountId, dependencies.reconcile)
      : yield* observeReconciliation(context.sourcePlan.accountId, dependencies.reconcile)
    return yield* settleSubmitReceipt(context, dependencies, {
      clientOrderId: prepared.clientOrderId,
      mutation: event,
      reconciliations: [before, afterActivation, finalReconciliation],
      restricted,
      recoveryRequired: !isTerminalSubmit(event),
    })
  })

const runExistingCancel = (
  context: PaperProofOperationContext<'CANCEL'>,
  dependencies: PaperProofCancelDependencies,
  before: PaperProofReconciliation,
  existing: MutationEvent,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    yield* markRecoveryRequired(context, dependencies, 'CANCEL', 'paper-proof-existing-cancel')
    const event = isRecoveredCancellation(existing)
      ? existing
      : yield* recoverMutationLookup(context, MutationOperation.Cancel, () =>
          dependencies.execution.recover(context.sourcePlan.intentId),
        )
    yield* restrictPaperProof(dependencies, `paper-proof-cancel-${event.eventType.toLowerCase()}`)
    const settled = isRecoveredCancellation(event)
      ? yield* readPaperProofIntent(context, 'CANCEL', dependencies.readIntent).pipe(
          Effect.map((intent) => isCancellationSettled(event, intent)),
        )
      : false
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
      yield* persistRecoveryCompletion(context, { recovery: dependencies.recovery }, 'CANCEL', receipt)
    }
    return receipt
  })

const runPaperProofSubmitDataFirst = (
  context: PaperProofOperationContext<'SUBMIT'>,
  dependencies: PaperProofSubmitDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    const existingMarker = yield* ensureRecoveryMarkerCompatible(context, dependencies, 'SUBMIT')
    const before = yield* observeReconciliation(context.sourcePlan.accountId, dependencies.reconcile)
    const prepared = yield* prepareSubmitIntent(context, dependencies)
    const cancellation = yield* readPaperProofMutation(
      context,
      'SUBMIT',
      dependencies.mutations,
      MutationOperation.Cancel,
    )
    if (cancellation !== undefined) {
      return yield* paperProofFailure(
        'SUBMIT',
        'paper proof submit is superseded by a durable cancellation mutation',
        cancellation,
        'mutation-unresolved',
      )
    }
    const existing = yield* readPaperProofMutation(context, 'SUBMIT', dependencies.mutations, MutationOperation.Submit)
    const admission = yield* Effect.fromResult(decideSubmitAdmission(cancellation, existing))
    return admission._tag === 'New'
      ? yield* runNewSubmit(context, dependencies, prepared, before)
      : yield* runExistingSubmit(context, dependencies, prepared, before, admission.event, existingMarker)
  })

export const runPaperProofSubmit = Pipeable.dual(2, runPaperProofSubmitDataFirst)

const runPaperProofCancelDataFirst = (
  context: PaperProofOperationContext<'CANCEL'>,
  dependencies: PaperProofCancelDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    const before = yield* observeReconciliation(context.sourcePlan.accountId, dependencies.reconcile)
    const prepared = yield* prepareCancellation(context, dependencies)
    if (prepared.existing !== undefined)
      return yield* runExistingCancel(context, dependencies, before, prepared.existing)

    const event = yield* lift(
      'CANCEL',
      'paper proof identified cancellation failed',
      dependencies.execution.cancel(context.sourcePlan.intentId, context.command.consistencyDelayMs, () =>
        markRecoveryRequired(context, dependencies, 'CANCEL', 'paper-proof-cancel'),
      ),
    )
    const recovered = isRecoveredCancellation(event)
      ? event
      : yield* recoverMutationLookup(context, MutationOperation.Cancel, () =>
          dependencies.execution.recover(context.sourcePlan.intentId),
        )
    yield* restrictPaperProof(dependencies, `paper-proof-cancel-${recovered.eventType.toLowerCase()}`)
    const settled = isRecoveredCancellation(recovered)
      ? yield* readPaperProofIntent(context, 'CANCEL', dependencies.readIntent).pipe(
          Effect.map((intent) => isCancellationSettled(recovered, intent)),
        )
      : false
    const after = settled
      ? yield* reconcileExact(context.sourcePlan.accountId, dependencies.reconcile)
      : yield* observeReconciliation(context.sourcePlan.accountId, dependencies.reconcile)
    const receipt = yield* completePaperProofReceipt(context, dependencies.currentUtcInstant, {
      mutation: recovered,
      reconciliations: [before, after],
      restricted: true,
      recoveryRequired: !settled,
    })
    if (settled) {
      yield* persistRecoveryCompletion(context, { recovery: dependencies.recovery }, 'CANCEL', receipt)
    }
    return receipt
  })

export const runPaperProofCancel = Pipeable.dual(2, runPaperProofCancelDataFirst)
