import { Duration, Effect, Exit } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations'
import type { CapitalGrantGeneration, CapitalGrantProofBinding } from '../execution/contracts'
import { MutationEventType, type MutationEvent, type MutationStoreShape } from '../execution/mutations'
import type { ExecutionProgram } from '../execution/runtime-program'
import { validatePaperProofEntry } from './gates'
import {
  PaperProofError,
  paperProofReceiptSchemaVersion,
  proofBinding,
  type PaperProofCommand,
  type PaperProofReceipt,
  type PaperProofReconciliation,
  type PaperProofRuntimeBinding,
  type PaperProofSourcePlan,
  type PreparedPaperProofIntent,
} from './model'

export interface PaperProofDependencies {
  readonly sourcePlan: PaperProofSourcePlan
  readonly runtime: PaperProofRuntimeBinding
  readonly protectedEntryToken: string
  readonly prepareCapitalGrant: (proof: CapitalGrantProofBinding) => Effect.Effect<CapitalGrantGeneration, unknown>
  readonly activateCapitalGrant: (proof: CapitalGrantProofBinding) => Effect.Effect<unknown, unknown>
  readonly restrictAuthority: (reason: string, updatedAt: string) => Effect.Effect<void, unknown>
  readonly mutations: Pick<MutationStoreShape, 'latest'>
  readonly execution: Pick<ExecutionProgram, 'submit' | 'cancel' | 'recover'>
  readonly prepareIntent: () => Effect.Effect<PreparedPaperProofIntent, unknown>
  readonly reconcile: () => Effect.Effect<PaperProofReconciliation, unknown>
  readonly currentUtcInstant: Effect.Effect<string, unknown>
}

const paperProofFailure = (
  operation: PaperProofError['operation'],
  message: string,
  cause: unknown,
  failure: PaperProofError['failure'] = 'operational',
): PaperProofError => new PaperProofError({ operation, failure, message, cause })

const lift = <A>(
  operation: PaperProofError['operation'],
  message: string,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, PaperProofError> =>
  effect.pipe(Effect.mapError((cause) => paperProofFailure(operation, message, cause)))

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

const restrict = (
  dependencies: PaperProofDependencies,
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

const finalizeMutationFailure = (
  dependencies: PaperProofDependencies,
  reason: string,
): Effect.Effect<void, PaperProofError> =>
  Effect.gen(function* () {
    const restrictionExit = yield* Effect.exit(restrict(dependencies, reason))
    const reconciliationExit = yield* Effect.exit(observeReconciliation(dependencies))
    if (Exit.isFailure(restrictionExit)) return yield* restrictionExit
    if (Exit.isFailure(reconciliationExit)) return yield* reconciliationExit
  })

const withMutationFailureFinalizer = <A>(
  dependencies: PaperProofDependencies,
  reason: string,
  effect: Effect.Effect<A, PaperProofError>,
): Effect.Effect<A, PaperProofError> =>
  Effect.uninterruptibleMask((restore) =>
    restore(effect).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? finalizeMutationFailure(dependencies, reason) : Effect.void,
      ),
    ),
  )

const activateAndRun = <A>(
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  effect: Effect.Effect<A, PaperProofError>,
): Effect.Effect<A, PaperProofError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const activationExit = yield* Effect.exit(
        restore(
          lift(
            'SUBMIT',
            'paper proof generation activation failed',
            dependencies.activateCapitalGrant(proofBinding(command)),
          ),
        ),
      )
      if (Exit.isFailure(activationExit)) {
        yield* finalizeMutationFailure(dependencies, 'paper-proof-submit-activation-failure')
        return yield* activationExit
      }
      return yield* restore(effect).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? finalizeMutationFailure(dependencies, 'paper-proof-submit-post-activation-failure')
            : Effect.void,
        ),
      )
    }),
  )

const successfulSubmit = (event: MutationEvent): boolean =>
  event.operation === MutationOperation.Submit &&
  (event.eventType === MutationEventType.SubmitAccepted || event.eventType === MutationEventType.RecoveryFound)

const terminalSubmit = (event: MutationEvent): boolean =>
  successfulSubmit(event) ||
  event.eventType === MutationEventType.SubmitRejected ||
  event.eventType === MutationEventType.SubmitDenied

const recoveredCancellation = (event: MutationEvent): boolean =>
  event.operation === MutationOperation.Cancel && event.eventType === MutationEventType.RecoveryFound

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

const readSubmit = (
  dependencies: PaperProofDependencies,
): Effect.Effect<MutationEvent | undefined, PaperProofError> =>
  lift(
    'SUBMIT',
    'paper proof durable submit read failed',
    dependencies.mutations.latest(dependencies.sourcePlan.intentId, MutationOperation.Submit),
  )

const waitForRecovery = (command: PaperProofCommand): Effect.Effect<void> =>
  Effect.sleep(Duration.millis(command.consistencyDelayMs))

const recoverSubmit = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<MutationEvent, PaperProofError> =>
  waitForRecovery(command).pipe(
    Effect.andThen(
      lift(
        'RECOVER',
        'paper proof lookup-only submit recovery failed',
        dependencies.execution.recover(dependencies.sourcePlan.intentId, MutationOperation.Submit),
      ),
    ),
  )

const cancelOrRecover = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<MutationEvent, PaperProofError> =>
  Effect.gen(function* () {
    const intentId = dependencies.sourcePlan.intentId
    const existing = yield* lift(
      'CANCEL',
      'paper proof durable cancellation read failed',
      dependencies.mutations.latest(intentId, MutationOperation.Cancel),
    )
    const event =
      existing ??
      (yield* lift(
        'CANCEL',
        'paper proof identified cancellation failed',
        dependencies.execution.cancel(intentId, command.consistencyDelayMs),
      ))
    if (recoveredCancellation(event)) return event
    yield* waitForRecovery(command)
    return yield* lift(
      'CANCEL',
      'paper proof lookup-only cancellation recovery failed',
      dependencies.execution.recover(intentId, MutationOperation.Cancel),
    )
  })

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
    })
  })

const runExistingSubmit = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  prepared: PreparedPaperProofIntent,
  before: PaperProofReconciliation,
  existing: MutationEvent,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  withMutationFailureFinalizer(
    dependencies,
    'paper-proof-existing-submit-failure',
    Effect.gen(function* () {
      const event = terminalSubmit(existing) ? existing : yield* recoverSubmit(command, dependencies)
      let restricted = false
      if (!successfulSubmit(event)) {
        yield* restrict(dependencies, `paper-proof-submit-${event.eventType.toLowerCase()}`)
        restricted = true
      }
      const finalReconciliation = yield* reconcileExact(dependencies)
      return yield* completeReceipt(command, dependencies, {
        clientOrderId: prepared.clientOrderId,
        mutation: event,
        reconciliations: [before, finalReconciliation],
        restricted,
      })
    }),
  )

const runNewSubmit = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  prepared: PreparedPaperProofIntent,
  before: PaperProofReconciliation,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  requireExactReconciliation(before).pipe(
    Effect.andThen(
      activateAndRun(
        command,
        dependencies,
        Effect.gen(function* () {
          const afterActivation = yield* reconcileExact(dependencies)
          const event = yield* lift(
            'SUBMIT',
            'paper proof guarded submit failed',
            dependencies.execution.submit(prepared.intentId, command.consistencyDelayMs),
          )
          let restricted = false
          if (!successfulSubmit(event)) {
            yield* restrict(dependencies, `paper-proof-submit-${event.eventType.toLowerCase()}`)
            restricted = true
          }
          const finalReconciliation = yield* reconcileExact(dependencies)
          return yield* completeReceipt(command, dependencies, {
            clientOrderId: prepared.clientOrderId,
            mutation: event,
            reconciliations: [before, afterActivation, finalReconciliation],
            restricted,
          })
        }),
      ),
    ),
  )

const runSubmit = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    const before = yield* observeReconciliation(dependencies)
    const prepared = yield* prepareSubmitIntent(dependencies)
    const existing = yield* readSubmit(dependencies)
    return yield* (existing === undefined
      ? runNewSubmit(command, dependencies, prepared, before)
      : runExistingSubmit(command, dependencies, prepared, before, existing))
  })

const runCancel = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  withMutationFailureFinalizer(
    dependencies,
    'paper-proof-cancel-failure',
    Effect.gen(function* () {
      const before = yield* observeReconciliation(dependencies)
      const event = yield* cancelOrRecover(command, dependencies)
      let restricted = false
      if (!recoveredCancellation(event)) {
        yield* restrict(dependencies, `paper-proof-cancel-${event.eventType.toLowerCase()}`)
        restricted = true
      }
      const after = yield* reconcileExact(dependencies)
      return yield* completeReceipt(command, dependencies, {
        mutation: event,
        reconciliations: [before, after],
        restricted,
      })
    }),
  )

const runRecover = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  withMutationFailureFinalizer(
    dependencies,
    'paper-proof-recover-failure',
    Effect.gen(function* () {
      const before = yield* observeReconciliation(dependencies)
      const event = yield* recoverSubmit(command, dependencies)
      let restricted = false
      if (!successfulSubmit(event)) {
        yield* restrict(dependencies, `paper-proof-recover-${event.eventType.toLowerCase()}`)
        restricted = true
      }
      const after = yield* reconcileExact(dependencies)
      return yield* completeReceipt(command, dependencies, {
        mutation: event,
        reconciliations: [before, after],
        restricted,
      })
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

export const runPaperProof = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.fromResult(
    validatePaperProofEntry(
      command,
      dependencies.sourcePlan,
      dependencies.runtime,
      dependencies.protectedEntryToken,
    ),
  ).pipe(
    Effect.andThen(runValidatedPaperProof(command, dependencies)),
    Effect.timeoutOrElse({
      duration: Duration.millis(command.timeoutMs),
      orElse: () =>
        Effect.fail(
          new PaperProofError({
            operation: 'TIMEOUT',
            failure: 'timeout',
            message: `paper proof command exceeded its ${command.timeoutMs.toString()}ms bound`,
          }),
        ),
    }),
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? Effect.logError('Bounded PAPER proof command failed').pipe(
            Effect.annotateLogs({ operation: command.operation, proofPlanHash: command.proofPlanHash }),
          )
        : Effect.void,
    ),
  )
