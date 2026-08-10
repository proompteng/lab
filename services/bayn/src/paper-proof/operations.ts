import { Duration, Effect, Result } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations'
import { IntentState } from '../execution/contracts'
import { MutationEventType, type MutationEvent, type MutationStoreShape } from '../execution/mutations'
import {
  PaperProofError,
  paperProofReceiptSchemaVersion,
  paperProofRecoveryCompletionSchemaVersion,
  paperProofRecoveryRequiredSchemaVersion,
  type PaperProofCommand,
  type PaperProofIntentSnapshot,
  type PaperProofMutationOperation,
  type PaperProofOperation,
  type PaperProofReceipt,
  type PaperProofReconciliation,
  type PaperProofRecoveryCompletion,
  type PaperProofRecoveryRequired,
  type PaperProofRecoveryStore,
  type PaperProofSourcePlan,
} from './model'

export type PaperProofCommandFor<Operation extends PaperProofOperation> = Omit<PaperProofCommand, 'operation'> & {
  readonly operation: Operation
}

export interface PaperProofOperationContext<Operation extends PaperProofOperation = PaperProofOperation> {
  readonly command: PaperProofCommandFor<Operation>
  readonly sourcePlan: PaperProofSourcePlan
}

export interface PaperProofContainmentDependencies {
  readonly restrictAuthority: (reason: string, updatedAt: string) => Effect.Effect<void, Error>
  readonly reconcile: Effect.Effect<PaperProofReconciliation, Error>
  readonly currentUtcInstant: Effect.Effect<string, Error>
}

export interface PaperProofRestrictionDependencies {
  readonly restrictAuthority: (reason: string, updatedAt: string) => Effect.Effect<void, Error>
  readonly currentUtcInstant: Effect.Effect<string, Error>
}

export type PaperProofMutationStore = Pick<MutationStoreShape, 'latest'>
export type PaperProofMutationRecoveryStore = Pick<PaperProofRecoveryStore, 'load' | 'markRequired' | 'complete'>

export type PaperProofReceiptFields = Omit<
  PaperProofReceipt,
  'schemaVersion' | 'operation' | 'proofPlanHash' | 'qualificationRunId' | 'intentId' | 'completedAt'
>

export type PaperProofExecutionHook = () => Effect.Effect<void, PaperProofError>

export const paperProofFailure = (
  operation: PaperProofError['operation'],
  message: string,
  cause: unknown,
  failure: PaperProofError['failure'] = 'operational',
): PaperProofError =>
  new PaperProofError({
    operation,
    failure,
    message,
    cause,
  })

export const timeoutFailure = (operation: PaperProofError['operation'], message: string): PaperProofError =>
  new PaperProofError({
    operation,
    failure: 'timeout',
    message,
  })

export const lift = <A>(
  operation: PaperProofError['operation'],
  message: string,
  effect: Effect.Effect<A, Error>,
): Effect.Effect<A, PaperProofError> =>
  effect.pipe(Effect.mapError((cause) => paperProofFailure(operation, message, cause)))

export const liftBounded = <A>(
  operation: PaperProofError['operation'],
  message: string,
  effect: Effect.Effect<A, Error>,
  timeoutMs: number,
): Effect.Effect<A, PaperProofError> =>
  lift(operation, message, effect).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () =>
        Effect.fail(
          timeoutFailure(operation, `${message} exceeded its ${timeoutMs.toString()}ms containment I/O bound`),
        ),
    }),
  )

export const validateReconciliationAccount = (
  expectedAccountId: string,
  reconciliation: PaperProofReconciliation,
): Result.Result<PaperProofReconciliation, PaperProofError> =>
  reconciliation.accountId === expectedAccountId
    ? Result.succeed(reconciliation)
    : Result.fail(
        paperProofFailure(
          'RECONCILE',
          'paper proof reconciliation account does not match the source-controlled account',
          reconciliation,
          'invariant',
        ),
      )

export const validateExactReconciliation = (
  reconciliation: PaperProofReconciliation,
): Result.Result<PaperProofReconciliation, PaperProofError> =>
  reconciliation.status === 'EXACT' && reconciliation.unknownMutationCount === 0
    ? Result.succeed(reconciliation)
    : Result.fail(
        paperProofFailure(
          'RECONCILE',
          'paper proof requires exact reconciliation with zero unknown mutations',
          reconciliation,
          'invariant',
        ),
      )

export const observeReconciliation = (
  accountId: string,
  reconcile: Effect.Effect<PaperProofReconciliation, Error>,
): Effect.Effect<PaperProofReconciliation, PaperProofError> =>
  lift('RECONCILE', 'paper proof reconciliation failed', reconcile).pipe(
    Effect.flatMap((result) => Effect.fromResult(validateReconciliationAccount(accountId, result))),
  )

export const reconcileExact = (
  accountId: string,
  reconcile: Effect.Effect<PaperProofReconciliation, Error>,
): Effect.Effect<PaperProofReconciliation, PaperProofError> =>
  observeReconciliation(accountId, reconcile).pipe(
    Effect.flatMap((result) => Effect.fromResult(validateExactReconciliation(result))),
  )

export const restrictPaperProof = (
  dependencies: PaperProofRestrictionDependencies,
  reason: string,
): Effect.Effect<void, PaperProofError> =>
  lift('RESTRICT', 'paper proof failed to read the restriction clock', dependencies.currentUtcInstant).pipe(
    Effect.flatMap((updatedAt) =>
      lift(
        'RESTRICT',
        'paper proof failed to restrict mutation authority',
        dependencies.restrictAuthority(reason.slice(0, 240), updatedAt),
      ),
    ),
  )

export const makePaperProofReceipt = (
  context: PaperProofOperationContext,
  completedAt: string,
  input: PaperProofReceiptFields,
): PaperProofReceipt => ({
  schemaVersion: paperProofReceiptSchemaVersion,
  operation: context.command.operation,
  proofPlanHash: context.command.proofPlanHash,
  qualificationRunId: context.command.qualificationRunId,
  intentId: context.sourcePlan.intentId,
  completedAt,
  ...input,
})

export const completePaperProofReceipt = (
  context: PaperProofOperationContext,
  currentUtcInstant: Effect.Effect<string, Error>,
  input: PaperProofReceiptFields,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  lift(context.command.operation, 'paper proof completion clock failed', currentUtcInstant).pipe(
    Effect.map((completedAt) => makePaperProofReceipt(context, completedAt, input)),
  )

export const isSuccessfulSubmit = (event: MutationEvent): boolean =>
  event.operation === MutationOperation.Submit &&
  (event.eventType === MutationEventType.SubmitAccepted || event.eventType === MutationEventType.RecoveryFound)

export const isTerminalSubmit = (event: MutationEvent): boolean =>
  event.operation === MutationOperation.Submit &&
  (isSuccessfulSubmit(event) ||
    event.eventType === MutationEventType.SubmitRejected ||
    event.eventType === MutationEventType.SubmitDenied)

export const isRecoveredCancellation = (event: MutationEvent): boolean =>
  event.operation === MutationOperation.Cancel && event.eventType === MutationEventType.RecoveryFound

export const isCancellationSettled = (event: MutationEvent, intent: PaperProofIntentSnapshot): boolean =>
  isRecoveredCancellation(event) && intent.state === IntentState.Terminal && intent.terminalOutcome !== undefined

export type SubmitAdmission =
  | {
      readonly _tag: 'New'
    }
  | {
      readonly _tag: 'Existing'
      readonly event: MutationEvent
    }

export const decideSubmitAdmission = (
  cancellation: MutationEvent | undefined,
  existing: MutationEvent | undefined,
): Result.Result<SubmitAdmission, PaperProofError> => {
  if (cancellation !== undefined) {
    return Result.fail(
      paperProofFailure(
        'SUBMIT',
        'paper proof submit is superseded by a durable cancellation mutation',
        cancellation,
        'mutation-unresolved',
      ),
    )
  }
  return existing === undefined
    ? Result.succeed({ _tag: 'New' })
    : Result.succeed({ _tag: 'Existing', event: existing })
}

export type CancellationAdmission =
  | {
      readonly _tag: 'Existing'
      readonly event: MutationEvent
    }
  | {
      readonly _tag: 'New'
    }

export const decideCancellationAdmission = (
  existing: MutationEvent | undefined,
  submitted: MutationEvent | undefined,
  intent: PaperProofIntentSnapshot | undefined,
): Result.Result<CancellationAdmission, PaperProofError> => {
  if (existing !== undefined) return Result.succeed({ _tag: 'Existing', event: existing })
  if (submitted === undefined || !isSuccessfulSubmit(submitted) || submitted.brokerOrderId === undefined) {
    return Result.fail(
      paperProofFailure(
        'CANCEL',
        'paper proof cancellation requires an exact durable submitted broker order',
        submitted,
        'mutation-unresolved',
      ),
    )
  }
  if (intent === undefined) {
    return Result.fail(paperProofFailure('CANCEL', 'paper proof durable intent does not exist', intent, 'invariant'))
  }
  if (intent.state !== IntentState.Acknowledged) {
    return Result.fail(
      paperProofFailure(
        'CANCEL',
        'paper proof cancellation requires an acknowledged durable intent',
        intent,
        'mutation-unresolved',
      ),
    )
  }
  return Result.succeed({ _tag: 'New' })
}

export const sameMutationEvent = (left: MutationEvent, right: MutationEvent): boolean =>
  left.schemaVersion === right.schemaVersion &&
  left.eventId === right.eventId &&
  left.mutationId === right.mutationId &&
  left.intentId === right.intentId &&
  left.sequence === right.sequence &&
  left.operation === right.operation &&
  left.eventType === right.eventType &&
  left.requestHash === right.requestHash &&
  left.consistencyDelayMs === right.consistencyDelayMs &&
  left.brokerOrderId === right.brokerOrderId &&
  left.requestId === right.requestId &&
  left.responseStatus === right.responseStatus &&
  left.responseContentHash === right.responseContentHash &&
  left.occurredAt === right.occurredAt

export interface DurableMutationState {
  readonly submit?: MutationEvent
  readonly cancel?: MutationEvent
}

export const markerMutationOperation = (operation: PaperProofMutationOperation): MutationOperation =>
  operation === 'CANCEL' ? MutationOperation.Cancel : MutationOperation.Submit

export const mutationForOperation = (
  state: DurableMutationState,
  operation: PaperProofMutationOperation,
): MutationEvent | undefined => (operation === 'CANCEL' ? state.cancel : state.submit)

export const selectRecoveryOperation = (
  state: DurableMutationState,
  required: PaperProofRecoveryRequired | undefined,
): PaperProofMutationOperation | undefined => {
  if (state.cancel !== undefined) return 'CANCEL'
  if (required !== undefined) return required.operation
  return state.submit === undefined ? undefined : 'SUBMIT'
}

export const decideRecoverySelection = (
  state: DurableMutationState,
  required: PaperProofRecoveryRequired | undefined,
): Result.Result<
  { readonly operation: PaperProofMutationOperation; readonly recorded: MutationEvent },
  PaperProofError
> => {
  const operation = selectRecoveryOperation(state, required)
  if (operation === undefined) {
    return Result.fail(
      paperProofFailure(
        'RECOVERY_STATE',
        'paper proof RECOVER requires a durable marker, completion, or mutation evidence',
        { required, mutations: state },
        'mutation-unresolved',
      ),
    )
  }
  const recorded = mutationForOperation(state, operation)
  return recorded === undefined
    ? Result.fail(
        paperProofFailure(
          'RECOVERY_STATE',
          'paper proof recovery marker does not have a durable mutation to recover',
          { operation, required, mutations: state },
          'mutation-unresolved',
        ),
      )
    : Result.succeed({ operation, recorded })
}

export const completionMatchesAuthoritativeMutation = (
  state: DurableMutationState,
  completion: PaperProofRecoveryCompletion,
): boolean => {
  if (completion.operation === 'SUBMIT' && state.cancel !== undefined) return false
  const latest = mutationForOperation(state, completion.operation)
  return latest !== undefined && sameMutationEvent(latest, completion.mutation)
}

export const validateCompletionMutationIdentity = (
  context: PaperProofOperationContext,
  completion: PaperProofRecoveryCompletion,
): Result.Result<void, PaperProofError> => {
  const expectedOperation = markerMutationOperation(completion.operation)
  return completion.mutation.intentId === context.sourcePlan.intentId &&
    completion.mutation.operation === expectedOperation
    ? Result.succeed(undefined)
    : Result.fail(
        paperProofFailure(
          'RECOVERY_STATE',
          'paper proof durable recovery completion mutation identity is invalid',
          completion,
          'invariant',
        ),
      )
}

export const recoveryIdentityMatches = (
  context: PaperProofOperationContext,
  value: Pick<PaperProofRecoveryRequired, 'intentId' | 'proofPlanHash' | 'qualificationRunId'>,
): boolean =>
  value.intentId === context.sourcePlan.intentId &&
  value.proofPlanHash === context.command.proofPlanHash &&
  value.qualificationRunId === context.command.qualificationRunId

export interface PaperProofRecoveryMarkerDependencies {
  readonly recovery: Pick<PaperProofRecoveryStore, 'load' | 'markRequired'>
  readonly currentUtcInstant: Effect.Effect<string, Error>
}

export const ensureRecoveryMarkerCompatible = (
  context: PaperProofOperationContext,
  dependencies: PaperProofRecoveryMarkerDependencies,
  operation: PaperProofMutationOperation,
): Effect.Effect<PaperProofRecoveryRequired | undefined, PaperProofError> =>
  liftBounded(
    'RECOVERY_STATE',
    'paper proof failed to load the existing durable recovery marker',
    dependencies.recovery.load(context.sourcePlan.intentId),
    context.command.containmentIoTimeoutMs,
  ).pipe(
    Effect.flatMap((existing) => {
      if (existing === undefined) return Effect.as(Effect.void, undefined)
      if (!recoveryIdentityMatches(context, existing)) {
        return Effect.fail(
          paperProofFailure(
            'RECOVERY_STATE',
            'paper proof durable recovery marker does not match the pinned proof identity',
            existing,
            'invariant',
          ),
        )
      }
      if (existing.operation === 'CANCEL' && operation === 'SUBMIT') {
        return Effect.fail(
          paperProofFailure(
            'RECOVERY_STATE',
            'paper proof cannot replace an unresolved cancellation marker with submit recovery',
            existing,
            'mutation-unresolved',
          ),
        )
      }
      return Effect.succeed(existing)
    }),
  )

export const makeRecoveryRequired = (
  context: PaperProofOperationContext,
  operation: PaperProofMutationOperation,
  reason: string,
  requiredAt: string,
): PaperProofRecoveryRequired => ({
  schemaVersion: paperProofRecoveryRequiredSchemaVersion,
  intentId: context.sourcePlan.intentId,
  proofPlanHash: context.command.proofPlanHash,
  qualificationRunId: context.command.qualificationRunId,
  operation,
  reason: reason.slice(0, 240),
  requiredAt,
})

export const markRecoveryRequired = (
  context: PaperProofOperationContext,
  dependencies: PaperProofRecoveryMarkerDependencies,
  operation: PaperProofMutationOperation,
  reason: string,
): Effect.Effect<void, PaperProofError> =>
  ensureRecoveryMarkerCompatible(context, dependencies, operation).pipe(
    Effect.flatMap((existing) => {
      if (existing?.operation === operation) return Effect.void
      return liftBounded(
        'RECOVERY_STATE',
        'paper proof failed to read the recovery marker clock',
        dependencies.currentUtcInstant,
        context.command.containmentIoTimeoutMs,
      ).pipe(
        Effect.flatMap((requiredAt) =>
          liftBounded(
            'RECOVERY_STATE',
            'paper proof failed to durably mark recovery required',
            dependencies.recovery.markRequired(makeRecoveryRequired(context, operation, reason, requiredAt)),
            context.command.containmentIoTimeoutMs,
          ),
        ),
      )
    }),
  )

export const loadRecoveryRequired = (
  context: PaperProofOperationContext,
  recovery: Pick<PaperProofRecoveryStore, 'load'>,
): Effect.Effect<PaperProofRecoveryRequired | undefined, PaperProofError> =>
  liftBounded(
    'RECOVERY_STATE',
    'paper proof failed to load the durable recovery marker',
    recovery.load(context.sourcePlan.intentId),
    context.command.containmentIoTimeoutMs,
  ).pipe(
    Effect.flatMap((required) =>
      required === undefined || recoveryIdentityMatches(context, required)
        ? Effect.succeed(required)
        : Effect.fail(
            paperProofFailure(
              'RECOVERY_STATE',
              'paper proof durable recovery marker does not match the pinned proof identity',
              required,
              'invariant',
            ),
          ),
    ),
  )

export const loadRecoveryCompletion = (
  context: PaperProofOperationContext,
  recovery: Pick<PaperProofRecoveryStore, 'loadCompletion'>,
): Effect.Effect<PaperProofRecoveryCompletion | undefined, PaperProofError> =>
  liftBounded(
    'RECOVERY_STATE',
    'paper proof failed to load durable recovery completion',
    recovery.loadCompletion(context.sourcePlan.intentId),
    context.command.containmentIoTimeoutMs,
  ).pipe(
    Effect.flatMap((completion) => {
      if (completion !== undefined && !recoveryIdentityMatches(context, completion)) {
        return Effect.fail(
          paperProofFailure(
            'RECOVERY_STATE',
            'paper proof durable recovery completion does not match the pinned proof identity',
            completion,
            'invariant',
          ),
        )
      }
      return Effect.succeed(completion)
    }),
  )

export const readPaperProofIntent = (
  context: PaperProofOperationContext,
  operation: PaperProofError['operation'],
  readIntent: (intentId: string) => Effect.Effect<PaperProofIntentSnapshot | undefined, Error>,
): Effect.Effect<PaperProofIntentSnapshot, PaperProofError> =>
  lift(operation, 'paper proof durable intent read failed', readIntent(context.sourcePlan.intentId)).pipe(
    Effect.flatMap((snapshot) =>
      snapshot === undefined
        ? Effect.fail(paperProofFailure(operation, 'paper proof durable intent does not exist', snapshot, 'invariant'))
        : Effect.succeed(snapshot),
    ),
  )

export const readPaperProofMutation = (
  context: PaperProofOperationContext,
  operation: PaperProofError['operation'],
  mutations: PaperProofMutationStore,
  mutationOperation: MutationOperation,
): Effect.Effect<MutationEvent | undefined, PaperProofError> =>
  lift(
    operation,
    `paper proof durable ${mutationOperation.toLowerCase()} read failed`,
    mutations.latest(context.sourcePlan.intentId, mutationOperation),
  )

export const readDurableMutationState = (
  context: PaperProofOperationContext,
  operation: PaperProofError['operation'],
  mutations: PaperProofMutationStore,
): Effect.Effect<DurableMutationState, PaperProofError> =>
  Effect.gen(function* () {
    const submit = yield* readPaperProofMutation(context, operation, mutations, MutationOperation.Submit)
    const cancel = yield* readPaperProofMutation(context, operation, mutations, MutationOperation.Cancel)
    return {
      ...(submit === undefined ? {} : { submit }),
      ...(cancel === undefined ? {} : { cancel }),
    }
  })

export const recoverMutationLookup = (
  context: PaperProofOperationContext,
  operation: MutationOperation,
  recover: () => Effect.Effect<MutationEvent, Error>,
): Effect.Effect<MutationEvent, PaperProofError> =>
  Effect.sleep(Duration.millis(context.command.consistencyDelayMs)).pipe(
    Effect.andThen(lift('RECOVER', `paper proof lookup-only ${operation.toLowerCase()} recovery failed`, recover())),
  )

export const makeRecoveryCompletion = (
  context: PaperProofOperationContext,
  operation: PaperProofMutationOperation,
  receipt: PaperProofReceipt,
): Result.Result<PaperProofRecoveryCompletion, PaperProofError> =>
  receipt.mutation === undefined
    ? Result.fail(
        paperProofFailure(
          'RECOVERY_STATE',
          'paper proof recovery completion requires durable mutation evidence',
          receipt,
          'invariant',
        ),
      )
    : Result.succeed({
        schemaVersion: paperProofRecoveryCompletionSchemaVersion,
        intentId: context.sourcePlan.intentId,
        proofPlanHash: context.command.proofPlanHash,
        qualificationRunId: context.command.qualificationRunId,
        operation,
        ...(receipt.clientOrderId === undefined ? {} : { clientOrderId: receipt.clientOrderId }),
        mutation: receipt.mutation,
        reconciliations: receipt.reconciliations,
        restricted: receipt.restricted,
        completedAt: receipt.completedAt,
      })

export const completeRecovery = (
  context: PaperProofOperationContext,
  recovery: Pick<PaperProofRecoveryStore, 'complete'>,
  latestCancellation: (() => Effect.Effect<MutationEvent | undefined, Error>) | undefined,
  completion: PaperProofRecoveryCompletion,
): Effect.Effect<void, PaperProofError> =>
  Effect.gen(function* () {
    if (completion.operation === 'SUBMIT') {
      if (latestCancellation === undefined) {
        return yield* paperProofFailure(
          'RECOVERY_STATE',
          'paper proof submit completion is missing its cancellation-state reader',
          completion,
          'invariant',
        )
      }
      const cancellation = yield* lift(
        'RECOVERY_STATE',
        'paper proof failed to verify submit completion against durable cancellation state',
        latestCancellation(),
      )
      if (cancellation !== undefined) {
        return yield* paperProofFailure(
          'RECOVERY_STATE',
          'paper proof submit completion is superseded by a durable cancellation mutation',
          cancellation,
          'mutation-unresolved',
        )
      }
    }
    yield* liftBounded(
      'RECOVERY_STATE',
      'paper proof failed to atomically persist recovery completion',
      recovery.complete(completion, {
        expectedLatestMutation: completion.mutation,
        rejectAnyCancellation: completion.operation === 'SUBMIT',
      }),
      context.command.containmentIoTimeoutMs,
    )
  })

export const persistRecoveryCompletion = (
  context: PaperProofOperationContext,
  dependencies: {
    readonly recovery: Pick<PaperProofRecoveryStore, 'complete'>
    readonly latestCancellation?: () => Effect.Effect<MutationEvent | undefined, Error>
  },
  operation: PaperProofMutationOperation,
  receipt: PaperProofReceipt,
): Effect.Effect<void, PaperProofError> =>
  Effect.fromResult(makeRecoveryCompletion(context, operation, receipt)).pipe(
    Effect.flatMap((completion) =>
      completeRecovery(context, dependencies.recovery, dependencies.latestCancellation, completion),
    ),
  )

export const makeReceiptFromCompletion = (
  context: PaperProofOperationContext,
  completion: PaperProofRecoveryCompletion,
): PaperProofReceipt => ({
  schemaVersion: paperProofReceiptSchemaVersion,
  operation: context.command.operation,
  proofPlanHash: context.command.proofPlanHash,
  qualificationRunId: context.command.qualificationRunId,
  intentId: context.sourcePlan.intentId,
  ...(completion.clientOrderId === undefined ? {} : { clientOrderId: completion.clientOrderId }),
  mutation: completion.mutation,
  reconciliations: completion.reconciliations,
  restricted: completion.restricted,
  recoveryRequired: false,
  completedAt: completion.completedAt,
})
