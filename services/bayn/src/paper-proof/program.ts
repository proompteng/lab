import { Clock, Duration, Effect, Exit } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations'
import { IntentState } from '../execution/contracts'
import type { CapitalGrantGeneration, CapitalGrantProofBinding } from '../execution/contracts'
import { MutationEventType, type MutationEvent, type MutationStoreShape } from '../execution/mutations'
import { utcInstantFromEpochMillis } from '../time'
import { hasPaperProofMutationAuthority, validatePaperProofEntry } from './gates'
import {
  PaperProofError,
  paperProofReceiptSchemaVersion,
  paperProofRecoveryCompletionSchemaVersion,
  paperProofRecoveryRequiredSchemaVersion,
  proofBinding,
  type PaperProofCommand,
  type PaperProofIntentSnapshot,
  type PaperProofMutationOperation,
  type PaperProofReceipt,
  type PaperProofReconciliation,
  type PaperProofRecoveryCompletion,
  type PaperProofRecoveryRequired,
  type PaperProofRecoveryStore,
  type PaperProofRuntimeBinding,
  type PaperProofSourcePlan,
  type PreparedPaperProofIntent,
} from './model'

const containmentIoCount = 3
const malformedCommandContainmentIoTimeoutMs = 5_000
const malformedCommandContainmentTotalTimeoutMs = 20_000

interface PaperProofContainmentContext {
  readonly operation: PaperProofError['operation']
  readonly containmentIoTimeoutMs: number
}

export interface PaperProofDependencies {
  readonly sourcePlan: PaperProofSourcePlan
  readonly runtime: PaperProofRuntimeBinding
  readonly protectedEntryToken: string
  readonly prepareCapitalGrant: (proof: CapitalGrantProofBinding) => Effect.Effect<CapitalGrantGeneration, Error>
  readonly activateCapitalGrant: (proof: CapitalGrantProofBinding) => Effect.Effect<void, Error>
  readonly restrictAuthority: (reason: string, updatedAt: string) => Effect.Effect<void, Error>
  readonly recovery: PaperProofRecoveryStore
  readonly mutations: Pick<MutationStoreShape, 'latest'>
  readonly execution: {
    /**
     * The adapter must invoke `beforeBrokerMutation` exactly once after every local and durable submit prerequisite
     * passes and the durable submit mutation has started, immediately before the broker POST. If the hook fails, the
     * adapter must not issue broker I/O.
     */
    readonly submit: (
      intentId: string,
      consistencyDelayMs: number,
      beforeBrokerMutation: () => Effect.Effect<void, PaperProofError>,
    ) => Effect.Effect<MutationEvent, Error>
    /**
     * The adapter must invoke `beforeBrokerMutation` exactly once after every local and durable cancellation
     * prerequisite passes and the durable cancellation mutation has started, immediately before the broker DELETE.
     * If the hook fails, the adapter must not issue broker I/O.
     */
    readonly cancel: (
      intentId: string,
      consistencyDelayMs: number,
      beforeBrokerMutation: () => Effect.Effect<void, PaperProofError>,
    ) => Effect.Effect<MutationEvent, Error>
    readonly recover: (intentId: string, operation: MutationOperation) => Effect.Effect<MutationEvent, Error>
  }
  readonly prepareIntent: () => Effect.Effect<PreparedPaperProofIntent, Error>
  readonly readIntent: (intentId: string) => Effect.Effect<PaperProofIntentSnapshot | undefined, Error>
  readonly reconcile: () => Effect.Effect<PaperProofReconciliation, Error>
  readonly currentUtcInstant: Effect.Effect<string, Error>
}

const paperProofFailure = (
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

const timeoutFailure = (operation: PaperProofError['operation'], message: string): PaperProofError =>
  new PaperProofError({
    operation,
    failure: 'timeout',
    message,
  })

const lift = <A>(
  operation: PaperProofError['operation'],
  message: string,
  effect: Effect.Effect<A, Error>,
): Effect.Effect<A, PaperProofError> =>
  effect.pipe(Effect.mapError((cause) => paperProofFailure(operation, message, cause)))

const liftBounded = <A>(
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

const requireSameAccountReconciliation = (
  expectedAccountId: string,
  reconciliation: PaperProofReconciliation,
): Effect.Effect<PaperProofReconciliation, PaperProofError> =>
  reconciliation.accountId === expectedAccountId
    ? Effect.succeed(reconciliation)
    : Effect.fail(
        paperProofFailure(
          'RECONCILE',
          'paper proof reconciliation account does not match the source-controlled account',
          reconciliation,
          'invariant',
        ),
      )

const requireExactReconciliation = (
  reconciliation: PaperProofReconciliation,
): Effect.Effect<PaperProofReconciliation, PaperProofError> => {
  if (reconciliation.status !== 'EXACT' || reconciliation.unknownMutationCount !== 0) {
    return Effect.fail(
      paperProofFailure(
        'RECONCILE',
        'paper proof requires exact reconciliation with zero unknown mutations',
        reconciliation,
        'invariant',
      ),
    )
  }
  return Effect.succeed(reconciliation)
}

const observeReconciliation = (
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReconciliation, PaperProofError> =>
  lift('RECONCILE', 'paper proof reconciliation failed', dependencies.reconcile()).pipe(
    Effect.flatMap((result) => requireSameAccountReconciliation(dependencies.sourcePlan.accountId, result)),
  )

const reconcileExact = (
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReconciliation, PaperProofError> =>
  observeReconciliation(dependencies).pipe(Effect.flatMap(requireExactReconciliation))

const restrict = (dependencies: PaperProofDependencies, reason: string): Effect.Effect<void, PaperProofError> =>
  lift('RESTRICT', 'paper proof failed to read the restriction clock', dependencies.currentUtcInstant).pipe(
    Effect.flatMap((updatedAt) =>
      lift(
        'RESTRICT',
        'paper proof failed to restrict mutation authority',
        dependencies.restrictAuthority(reason.slice(0, 240), updatedAt),
      ),
    ),
  )

const recoveryIdentityMatches = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  value: Pick<PaperProofRecoveryRequired, 'intentId' | 'proofPlanHash' | 'qualificationRunId'>,
): boolean =>
  value.intentId === dependencies.sourcePlan.intentId &&
  value.proofPlanHash === command.proofPlanHash &&
  value.qualificationRunId === command.qualificationRunId

const ensureRecoveryMarkerCompatible = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  operation: PaperProofMutationOperation,
): Effect.Effect<PaperProofRecoveryRequired | undefined, PaperProofError> =>
  liftBounded(
    'RECOVERY_STATE',
    'paper proof failed to load the existing durable recovery marker',
    dependencies.recovery.load(dependencies.sourcePlan.intentId),
    command.containmentIoTimeoutMs,
  ).pipe(
    Effect.flatMap((existing) => {
      if (existing === undefined) return Effect.succeed(undefined)
      if (!recoveryIdentityMatches(command, dependencies, existing)) {
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

const markRecoveryRequired = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  operation: PaperProofMutationOperation,
  reason: string,
): Effect.Effect<void, PaperProofError> =>
  ensureRecoveryMarkerCompatible(command, dependencies, operation).pipe(
    Effect.flatMap((existing) => {
      if (existing?.operation === operation) return Effect.void
      return liftBounded(
        'RECOVERY_STATE',
        'paper proof failed to read the recovery marker clock',
        dependencies.currentUtcInstant,
        command.containmentIoTimeoutMs,
      ).pipe(
        Effect.flatMap((requiredAt) =>
          liftBounded(
            'RECOVERY_STATE',
            'paper proof failed to durably mark recovery required',
            dependencies.recovery.markRequired({
              schemaVersion: paperProofRecoveryRequiredSchemaVersion,
              intentId: dependencies.sourcePlan.intentId,
              proofPlanHash: command.proofPlanHash,
              qualificationRunId: command.qualificationRunId,
              operation,
              reason: reason.slice(0, 240),
              requiredAt,
            }),
            command.containmentIoTimeoutMs,
          ),
        ),
      )
    }),
  )

const loadRecoveryRequired = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofRecoveryRequired | undefined, PaperProofError> =>
  liftBounded(
    'RECOVERY_STATE',
    'paper proof failed to load the durable recovery marker',
    dependencies.recovery.load(dependencies.sourcePlan.intentId),
    command.containmentIoTimeoutMs,
  ).pipe(
    Effect.flatMap((required) =>
      required === undefined || recoveryIdentityMatches(command, dependencies, required)
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

const loadRecoveryCompletion = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofRecoveryCompletion | undefined, PaperProofError> =>
  liftBounded(
    'RECOVERY_STATE',
    'paper proof failed to load durable recovery completion',
    dependencies.recovery.loadCompletion(dependencies.sourcePlan.intentId),
    command.containmentIoTimeoutMs,
  ).pipe(
    Effect.flatMap((completion) => {
      if (completion !== undefined && !recoveryIdentityMatches(command, dependencies, completion)) {
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

const completeRecovery = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  completion: PaperProofRecoveryCompletion,
): Effect.Effect<void, PaperProofError> =>
  Effect.gen(function* () {
    if (completion.operation === 'SUBMIT') {
      const cancellation = yield* lift(
        'RECOVERY_STATE',
        'paper proof failed to verify submit completion against durable cancellation state',
        dependencies.mutations.latest(dependencies.sourcePlan.intentId, MutationOperation.Cancel),
      )
      if (cancellation !== undefined) {
        return yield* Effect.fail(
          paperProofFailure(
            'RECOVERY_STATE',
            'paper proof submit completion is superseded by a durable cancellation mutation',
            cancellation,
            'mutation-unresolved',
          ),
        )
      }
    }
    yield* liftBounded(
      'RECOVERY_STATE',
      'paper proof failed to atomically persist recovery completion',
      dependencies.recovery.complete(completion, {
        expectedLatestMutation: completion.mutation,
        rejectAnyCancellation: completion.operation === 'SUBMIT',
      }),
      command.containmentIoTimeoutMs,
    )
  })

const persistRecoveryCompletion = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  operation: PaperProofMutationOperation,
  receipt: PaperProofReceipt,
): Effect.Effect<void, PaperProofError> => {
  if (receipt.mutation === undefined) {
    return Effect.fail(
      paperProofFailure(
        'RECOVERY_STATE',
        'paper proof recovery completion requires durable mutation evidence',
        receipt,
        'invariant',
      ),
    )
  }
  return completeRecovery(command, dependencies, {
    schemaVersion: paperProofRecoveryCompletionSchemaVersion,
    intentId: dependencies.sourcePlan.intentId,
    proofPlanHash: command.proofPlanHash,
    qualificationRunId: command.qualificationRunId,
    operation,
    ...(receipt.clientOrderId === undefined ? {} : { clientOrderId: receipt.clientOrderId }),
    mutation: receipt.mutation,
    reconciliations: receipt.reconciliations,
    restricted: receipt.restricted,
    completedAt: receipt.completedAt,
  })
}

const receiptFromCompletion = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  completion: PaperProofRecoveryCompletion,
): PaperProofReceipt => ({
  schemaVersion: paperProofReceiptSchemaVersion,
  operation: command.operation,
  proofPlanHash: command.proofPlanHash,
  qualificationRunId: command.qualificationRunId,
  intentId: dependencies.sourcePlan.intentId,
  ...(completion.clientOrderId === undefined ? {} : { clientOrderId: completion.clientOrderId }),
  mutation: completion.mutation,
  reconciliations: completion.reconciliations,
  restricted: completion.restricted,
  recoveryRequired: false,
  completedAt: completion.completedAt,
})

interface DurableMutationState {
  readonly submit?: MutationEvent
  readonly cancel?: MutationEvent
}

const readDurableMutationState = (
  operation: PaperProofError['operation'],
  dependencies: PaperProofDependencies,
): Effect.Effect<DurableMutationState, PaperProofError> =>
  Effect.gen(function* () {
    const submit = yield* readMutation(operation, dependencies, MutationOperation.Submit)
    const cancel = yield* readMutation(operation, dependencies, MutationOperation.Cancel)
    return {
      ...(submit === undefined ? {} : { submit }),
      ...(cancel === undefined ? {} : { cancel }),
    }
  })

const mutationForOperation = (
  state: DurableMutationState,
  operation: PaperProofMutationOperation,
): MutationEvent | undefined => (operation === 'CANCEL' ? state.cancel : state.submit)

const validateCompletionMutationIdentity = (
  dependencies: PaperProofDependencies,
  completion: PaperProofRecoveryCompletion,
): Effect.Effect<void, PaperProofError> => {
  const expectedOperation = markerMutationOperation(completion.operation)
  return completion.mutation.intentId === dependencies.sourcePlan.intentId &&
    completion.mutation.operation === expectedOperation
    ? Effect.void
    : Effect.fail(
        paperProofFailure(
          'RECOVERY_STATE',
          'paper proof durable recovery completion mutation identity is invalid',
          completion,
          'invariant',
        ),
      )
}

const sameMutationEvent = (left: MutationEvent, right: MutationEvent): boolean =>
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

const completionMatchesAuthoritativeMutation = (
  state: DurableMutationState,
  completion: PaperProofRecoveryCompletion,
): boolean => {
  if (completion.operation === 'SUBMIT' && state.cancel !== undefined) return false
  const latest = mutationForOperation(state, completion.operation)
  return latest !== undefined && sameMutationEvent(latest, completion.mutation)
}

const refreshCompletionAfterContainment = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  completion: PaperProofRecoveryCompletion,
): Effect.Effect<PaperProofRecoveryCompletion, PaperProofError> => {
  if (completion.restricted) return Effect.succeed(completion)
  return Effect.gen(function* () {
    const reconciliation = yield* reconcileExact(dependencies)
    const refreshed: PaperProofRecoveryCompletion = {
      ...completion,
      reconciliations: [...completion.reconciliations, reconciliation],
      restricted: true,
    }
    yield* completeRecovery(command, dependencies, refreshed)
    return refreshed
  })
}

const logContainmentFailure = <A>(
  operation: PaperProofError['operation'],
  step: string,
  exit: Exit.Exit<A, PaperProofError>,
): Effect.Effect<void> =>
  Exit.isFailure(exit)
    ? Effect.logError('PAPER proof containment step did not complete').pipe(
        Effect.annotateLogs({
          operation,
          containmentStep: step,
        }),
      )
    : Effect.void

const containFailure = (
  context: PaperProofContainmentContext,
  dependencies: PaperProofDependencies,
  reason: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const clockExit = yield* Effect.exit(
      liftBounded(
        'RESTRICT',
        'paper proof containment failed to read the restriction clock',
        dependencies.currentUtcInstant,
        context.containmentIoTimeoutMs,
      ),
    )
    yield* logContainmentFailure(context.operation, 'restriction-clock', clockExit)

    const restrictionTimestamp = Exit.isFailure(clockExit)
      ? yield* Clock.currentTimeMillis.pipe(Effect.map(utcInstantFromEpochMillis))
      : clockExit.value
    const restrictionExit = yield* Effect.exit(
      liftBounded(
        'RESTRICT',
        'paper proof containment failed to restrict mutation authority',
        dependencies.restrictAuthority(reason.slice(0, 240), restrictionTimestamp),
        context.containmentIoTimeoutMs,
      ),
    )
    yield* logContainmentFailure(context.operation, 'restrict-authority', restrictionExit)

    const reconciliationExit = yield* Effect.exit(
      liftBounded(
        'RECONCILE',
        'paper proof containment reconciliation failed',
        dependencies.reconcile(),
        context.containmentIoTimeoutMs,
      ).pipe(Effect.flatMap((result) => requireSameAccountReconciliation(dependencies.sourcePlan.accountId, result))),
    )
    yield* logContainmentFailure(context.operation, 'reconcile', reconciliationExit)
  })

const withRecoveryFinalizer = <A>(
  command: PaperProofContainmentContext,
  dependencies: PaperProofDependencies,
  reason: string,
  effect: Effect.Effect<A, PaperProofError>,
): Effect.Effect<A, PaperProofError> =>
  effect.pipe(
    Effect.onExit((exit) => (Exit.isFailure(exit) ? containFailure(command, dependencies, reason) : Effect.void)),
  )

export const containMalformedPaperProofCommand = (
  operation: PaperProofCommand['operation'] | 'GATE',
  dependencies: PaperProofDependencies,
  failure: PaperProofError,
): Effect.Effect<never, PaperProofError> =>
  withRecoveryFinalizer(
    {
      operation,
      containmentIoTimeoutMs: malformedCommandContainmentIoTimeoutMs,
    },
    dependencies,
    'paper-proof-malformed-command-envelope',
    Effect.fail(failure),
  ).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(malformedCommandContainmentTotalTimeoutMs),
      orElse: () =>
        commandTimeout(
          `paper proof malformed-command containment exceeded its ${malformedCommandContainmentTotalTimeoutMs.toString()}ms total bound`,
        ),
    }),
  )

const successfulSubmit = (event: MutationEvent): boolean =>
  event.operation === MutationOperation.Submit &&
  (event.eventType === MutationEventType.SubmitAccepted || event.eventType === MutationEventType.RecoveryFound)

const terminalSubmit = (event: MutationEvent): boolean =>
  event.operation === MutationOperation.Submit &&
  (successfulSubmit(event) ||
    event.eventType === MutationEventType.SubmitRejected ||
    event.eventType === MutationEventType.SubmitDenied)

const recoveredCancellation = (event: MutationEvent): boolean =>
  event.operation === MutationOperation.Cancel && event.eventType === MutationEventType.RecoveryFound

const readIntentSnapshot = (
  operation: PaperProofError['operation'],
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofIntentSnapshot, PaperProofError> =>
  lift(
    operation,
    'paper proof durable intent read failed',
    dependencies.readIntent(dependencies.sourcePlan.intentId),
  ).pipe(
    Effect.flatMap((snapshot) =>
      snapshot === undefined
        ? Effect.fail(paperProofFailure(operation, 'paper proof durable intent does not exist', snapshot, 'invariant'))
        : Effect.succeed(snapshot),
    ),
  )

const cancellationTerminal = (
  operation: Extract<PaperProofCommand['operation'], 'CANCEL' | 'RECOVER'>,
  dependencies: PaperProofDependencies,
  event: MutationEvent,
): Effect.Effect<boolean, PaperProofError> =>
  recoveredCancellation(event)
    ? readIntentSnapshot(operation, dependencies).pipe(
        Effect.map((snapshot) => snapshot.state === IntentState.Terminal && snapshot.terminalOutcome !== undefined),
      )
    : Effect.succeed(false)

const prepareSubmitIntent = (
  dependencies: PaperProofDependencies,
): Effect.Effect<PreparedPaperProofIntent, PaperProofError> =>
  lift('SUBMIT', 'paper proof intent preparation failed', dependencies.prepareIntent()).pipe(
    Effect.flatMap((prepared) =>
      prepared.intentId === dependencies.sourcePlan.intentId
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

const readMutation = (
  operation: PaperProofError['operation'],
  dependencies: PaperProofDependencies,
  mutationOperation: MutationOperation,
): Effect.Effect<MutationEvent | undefined, PaperProofError> =>
  lift(
    operation,
    `paper proof durable ${mutationOperation.toLowerCase()} read failed`,
    dependencies.mutations.latest(dependencies.sourcePlan.intentId, mutationOperation),
  )

const waitForRecovery = (command: PaperProofCommand): Effect.Effect<void> =>
  Effect.sleep(Duration.millis(command.consistencyDelayMs))

const recoverMutation = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  operation: MutationOperation,
): Effect.Effect<MutationEvent, PaperProofError> =>
  waitForRecovery(command).pipe(
    Effect.andThen(
      lift(
        'RECOVER',
        `paper proof lookup-only ${operation.toLowerCase()} recovery failed`,
        dependencies.execution.recover(dependencies.sourcePlan.intentId, operation),
      ),
    ),
  )

interface PreparedCancellation {
  readonly existing?: MutationEvent
}

const prepareCancellation = (
  dependencies: PaperProofDependencies,
): Effect.Effect<PreparedCancellation, PaperProofError> =>
  Effect.gen(function* () {
    const existing = yield* readMutation('CANCEL', dependencies, MutationOperation.Cancel)
    if (existing !== undefined) return { existing }

    const submitted = yield* readMutation('CANCEL', dependencies, MutationOperation.Submit)
    if (submitted === undefined || !successfulSubmit(submitted) || submitted.brokerOrderId === undefined) {
      return yield* Effect.fail(
        paperProofFailure(
          'CANCEL',
          'paper proof cancellation requires an exact durable submitted broker order',
          submitted,
          'mutation-unresolved',
        ),
      )
    }
    const intent = yield* readIntentSnapshot('CANCEL', dependencies)
    if (intent.state !== IntentState.Acknowledged) {
      return yield* Effect.fail(
        paperProofFailure(
          'CANCEL',
          'paper proof cancellation requires an acknowledged durable intent',
          intent,
          'mutation-unresolved',
        ),
      )
    }
    return {}
  })

const cancelOrRecover = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  prepared: PreparedCancellation,
): Effect.Effect<MutationEvent, PaperProofError> =>
  Effect.gen(function* () {
    const event =
      prepared.existing ??
      (yield* lift(
        'CANCEL',
        'paper proof identified cancellation failed',
        dependencies.execution.cancel(dependencies.sourcePlan.intentId, command.consistencyDelayMs, () =>
          markRecoveryRequired(command, dependencies, 'CANCEL', 'paper-proof-cancel'),
        ),
      ))
    return recoveredCancellation(event)
      ? event
      : yield* recoverMutation(command, dependencies, MutationOperation.Cancel)
  })

const markerMutationOperation = (operation: PaperProofMutationOperation): MutationOperation =>
  operation === 'CANCEL' ? MutationOperation.Cancel : MutationOperation.Submit

const completeReceipt = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  input: Omit<
    PaperProofReceipt,
    'schemaVersion' | 'operation' | 'proofPlanHash' | 'qualificationRunId' | 'intentId' | 'completedAt'
  >,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  lift(command.operation, 'paper proof completion clock failed', dependencies.currentUtcInstant).pipe(
    Effect.map((completedAt) => ({
      schemaVersion: paperProofReceiptSchemaVersion,
      operation: command.operation,
      proofPlanHash: command.proofPlanHash,
      qualificationRunId: command.qualificationRunId,
      intentId: dependencies.sourcePlan.intentId,
      completedAt,
      ...input,
    })),
  )

const runPrepare = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    const reconciliation = yield* reconcileExact(dependencies)
    const generation = yield* lift(
      'PREPARE',
      'paper proof generation PREPARE failed',
      dependencies.prepareCapitalGrant(proofBinding(command)),
    )
    return yield* completeReceipt(command, dependencies, {
      generation,
      reconciliations: [reconciliation],
      restricted: false,
      recoveryRequired: false,
    })
  })

const settleSubmitReceipt = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  operation: PaperProofMutationOperation,
  input: Parameters<typeof completeReceipt>[2],
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    const receipt = yield* completeReceipt(command, dependencies, input)
    if (!receipt.recoveryRequired) {
      yield* persistRecoveryCompletion(command, dependencies, operation, receipt)
    }
    return receipt
  })

const runExistingSubmit = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  prepared: PreparedPaperProofIntent,
  before: PaperProofReconciliation,
  existing: MutationEvent,
  existingMarker: PaperProofRecoveryRequired | undefined,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    if (!terminalSubmit(existing)) {
      yield* markRecoveryRequired(command, dependencies, 'SUBMIT', 'paper-proof-existing-submit')
    }
    const event = terminalSubmit(existing)
      ? existing
      : yield* recoverMutation(command, dependencies, MutationOperation.Submit)
    let restricted = false
    if (!successfulSubmit(event)) {
      yield* restrict(dependencies, `paper-proof-submit-${event.eventType.toLowerCase()}`)
      restricted = true
    }
    const finalReconciliation = terminalSubmit(event)
      ? yield* reconcileExact(dependencies)
      : yield* observeReconciliation(dependencies)
    const input = {
      clientOrderId: prepared.clientOrderId,
      mutation: event,
      reconciliations: [before, finalReconciliation],
      restricted,
      recoveryRequired: !terminalSubmit(event),
    } as const
    return terminalSubmit(existing) && existingMarker === undefined
      ? yield* completeReceipt(command, dependencies, input)
      : yield* settleSubmitReceipt(command, dependencies, 'SUBMIT', input)
  })

const runNewSubmit = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  prepared: PreparedPaperProofIntent,
  before: PaperProofReconciliation,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    yield* requireExactReconciliation(before)
    yield* lift(
      'SUBMIT',
      'paper proof generation activation failed',
      dependencies.activateCapitalGrant(proofBinding(command)),
    )
    const afterActivation = yield* reconcileExact(dependencies)
    const event = yield* lift(
      'SUBMIT',
      'paper proof guarded submit failed',
      dependencies.execution.submit(prepared.intentId, command.consistencyDelayMs, () =>
        markRecoveryRequired(command, dependencies, 'SUBMIT', 'paper-proof-new-submit'),
      ),
    )
    let restricted = false
    if (!successfulSubmit(event)) {
      yield* restrict(dependencies, `paper-proof-submit-${event.eventType.toLowerCase()}`)
      restricted = true
    }
    const finalReconciliation = terminalSubmit(event)
      ? yield* reconcileExact(dependencies)
      : yield* observeReconciliation(dependencies)
    return yield* settleSubmitReceipt(command, dependencies, 'SUBMIT', {
      clientOrderId: prepared.clientOrderId,
      mutation: event,
      reconciliations: [before, afterActivation, finalReconciliation],
      restricted,
      recoveryRequired: !terminalSubmit(event),
    })
  })

const runSubmit = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  withRecoveryFinalizer(
    command,
    dependencies,
    'paper-proof-submit-failure',
    Effect.gen(function* () {
      const existingMarker = yield* ensureRecoveryMarkerCompatible(command, dependencies, 'SUBMIT')
      const before = yield* observeReconciliation(dependencies)
      const prepared = yield* prepareSubmitIntent(dependencies)
      const cancellation = yield* readMutation('SUBMIT', dependencies, MutationOperation.Cancel)
      if (cancellation !== undefined) {
        return yield* Effect.fail(
          paperProofFailure(
            'SUBMIT',
            'paper proof submit is superseded by a durable cancellation mutation',
            cancellation,
            'mutation-unresolved',
          ),
        )
      }
      const existing = yield* readMutation('SUBMIT', dependencies, MutationOperation.Submit)
      return yield* existing === undefined
        ? runNewSubmit(command, dependencies, prepared, before)
        : runExistingSubmit(command, dependencies, prepared, before, existing, existingMarker)
    }),
  )

const runCancel = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  withRecoveryFinalizer(
    command,
    dependencies,
    'paper-proof-cancel-failure',
    Effect.gen(function* () {
      const before = yield* observeReconciliation(dependencies)
      const prepared = yield* prepareCancellation(dependencies)
      if (prepared.existing !== undefined) {
        yield* markRecoveryRequired(command, dependencies, 'CANCEL', 'paper-proof-existing-cancel')
      }
      const event = yield* cancelOrRecover(command, dependencies, prepared)
      yield* restrict(dependencies, `paper-proof-cancel-${event.eventType.toLowerCase()}`)
      const settled = yield* cancellationTerminal('CANCEL', dependencies, event)
      const after = settled ? yield* reconcileExact(dependencies) : yield* observeReconciliation(dependencies)
      const receipt = yield* completeReceipt(command, dependencies, {
        mutation: event,
        reconciliations: [before, after],
        restricted: true,
        recoveryRequired: !settled,
      })
      if (settled) {
        yield* persistRecoveryCompletion(command, dependencies, 'CANCEL', receipt)
      }
      return receipt
    }),
  )

const selectRecoveryOperation = (
  state: DurableMutationState,
  required: PaperProofRecoveryRequired | undefined,
): PaperProofMutationOperation | undefined => {
  if (state.cancel !== undefined) return 'CANCEL'
  if (required !== undefined) return required.operation
  return state.submit === undefined ? undefined : 'SUBMIT'
}

const recoverAuthoritativeMutation = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  operation: PaperProofMutationOperation,
  recorded: MutationEvent,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    const alreadySettled =
      operation === 'CANCEL' ? yield* cancellationTerminal('RECOVER', dependencies, recorded) : terminalSubmit(recorded)
    if (alreadySettled) {
      const reconciliation = yield* reconcileExact(dependencies)
      const receipt = yield* completeReceipt(command, dependencies, {
        mutation: recorded,
        reconciliations: [reconciliation],
        restricted: true,
        recoveryRequired: false,
      })
      yield* persistRecoveryCompletion(command, dependencies, operation, receipt)
      return receipt
    }

    const before = yield* observeReconciliation(dependencies)
    const event = yield* recoverMutation(command, dependencies, markerMutationOperation(operation))
    const settled =
      operation === 'CANCEL' ? yield* cancellationTerminal('RECOVER', dependencies, event) : terminalSubmit(event)
    const after = settled ? yield* reconcileExact(dependencies) : yield* observeReconciliation(dependencies)
    const receipt = yield* completeReceipt(command, dependencies, {
      mutation: event,
      reconciliations: [before, after],
      restricted: true,
      recoveryRequired: !settled,
    })
    if (settled) {
      yield* persistRecoveryCompletion(command, dependencies, operation, receipt)
    }
    return receipt
  })

const runRecover = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  withRecoveryFinalizer(
    command,
    dependencies,
    'paper-proof-recover-load-or-execution-failure',
    Effect.gen(function* () {
      yield* restrict(dependencies, 'paper-proof-recover-before-state-load')
      const completed = yield* loadRecoveryCompletion(command, dependencies)
      const required = yield* loadRecoveryRequired(command, dependencies)
      const mutations = yield* readDurableMutationState('RECOVER', dependencies)
      if (completed !== undefined && required === undefined) {
        yield* validateCompletionMutationIdentity(dependencies, completed)
        if (completionMatchesAuthoritativeMutation(mutations, completed)) {
          const settled =
            completed.operation === 'CANCEL'
              ? yield* cancellationTerminal('RECOVER', dependencies, completed.mutation)
              : terminalSubmit(completed.mutation)
          if (settled) {
            const refreshed = yield* refreshCompletionAfterContainment(command, dependencies, completed)
            return receiptFromCompletion(command, dependencies, refreshed)
          }
        }
      }

      const operation = selectRecoveryOperation(mutations, required)
      if (operation === undefined) {
        return yield* Effect.fail(
          paperProofFailure(
            'RECOVERY_STATE',
            'paper proof RECOVER requires a durable marker, completion, or mutation evidence',
            { completed, required, mutations },
            'mutation-unresolved',
          ),
        )
      }
      const recorded = mutationForOperation(mutations, operation)
      if (recorded === undefined) {
        return yield* Effect.fail(
          paperProofFailure(
            'RECOVERY_STATE',
            'paper proof recovery marker does not have a durable mutation to recover',
            { operation, required, mutations },
            'mutation-unresolved',
          ),
        )
      }
      if (required?.operation !== operation) {
        yield* markRecoveryRequired(command, dependencies, operation, 'paper-proof-reconstructed-recovery')
      }
      return yield* recoverAuthoritativeMutation(command, dependencies, operation, recorded)
    }),
  )

const runValidatedPaperProof = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> => {
  switch (command.operation) {
    case 'PREPARE':
      return runPrepare(command, dependencies)
    case 'SUBMIT':
      return runSubmit(command, dependencies)
    case 'CANCEL':
      return runCancel(command, dependencies)
    case 'RECOVER':
      return runRecover(command, dependencies)
  }
}

const commandTimeout = (message: string): Effect.Effect<never, PaperProofError> =>
  Effect.fail(
    new PaperProofError({
      operation: 'TIMEOUT',
      failure: 'timeout',
      message,
    }),
  )

export const runPaperProof = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> => {
  const requiresContainment = hasPaperProofMutationAuthority(dependencies.runtime)
  const executionTimeoutMs = requiresContainment
    ? command.timeoutMs - command.containmentIoTimeoutMs * containmentIoCount
    : command.timeoutMs
  const entry = Effect.fromResult(
    validatePaperProofEntry(command, dependencies.sourcePlan, dependencies.runtime, dependencies.protectedEntryToken),
  )
  const containedEntry = requiresContainment
    ? withRecoveryFinalizer(command, dependencies, 'paper-proof-entry-gate-failure', entry)
    : entry
  const execution = containedEntry.pipe(
    Effect.andThen(runValidatedPaperProof(command, dependencies)),
    Effect.timeoutOrElse({
      duration: Duration.millis(executionTimeoutMs),
      orElse: () =>
        commandTimeout(`paper proof execution exceeded its reserved ${executionTimeoutMs.toString()}ms window`),
    }),
  )

  return execution.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(command.timeoutMs),
      orElse: () => commandTimeout(`paper proof command exceeded its ${command.timeoutMs.toString()}ms total bound`),
    }),
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? Effect.logError('Bounded PAPER proof command failed').pipe(
            Effect.annotateLogs({
              operation: command.operation,
              proofPlanHash: command.proofPlanHash,
            }),
          )
        : Effect.void,
    ),
  )
}
