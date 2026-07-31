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
import type {
  PaperProofRecoveryRequired,
  PaperProofRecoveryStoreService,
} from './recovery-store'

export interface PaperProofDependencies {
  readonly sourcePlan: PaperProofSourcePlan
  readonly runtime: PaperProofRuntimeBinding
  readonly protectedEntryToken: string
  readonly prepareCapitalGrant: (proof: CapitalGrantProofBinding) => Effect.Effect<CapitalGrantGeneration, unknown>
  readonly activateCapitalGrant: (proof: CapitalGrantProofBinding) => Effect.Effect<unknown, unknown>
  readonly restrictAuthority: (reason: string, updatedAt: string) => Effect.Effect<void, unknown>
  readonly mutations: Pick<MutationStoreShape, 'latest'>
  readonly execution: Pick<ExecutionProgram, 'submit' | 'cancel' | 'recover'>
  readonly recovery: PaperProofRecoveryStoreService
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

const containmentTimeoutMs = (command: PaperProofCommand): number =>
  Math.max(1, Math.min(1_000, Math.floor(command.timeoutMs / 4)))

const boundedLift = <A>(
  command: PaperProofCommand,
  operation: PaperProofError['operation'],
  message: string,
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, PaperProofError> =>
  lift(operation, message, effect).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(containmentTimeoutMs(command)),
      orElse: () =>
        Effect.fail(
          paperProofFailure(
            operation,
            `${message} exceeded its containment bound`,
            undefined,
            'timeout',
          ),
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

const observeReconciliationBounded = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReconciliation, PaperProofError> =>
  boundedLift(
    command,
    'RECONCILE',
    'paper proof containment reconciliation failed',
    dependencies.reconcile(),
  ).pipe(
    Effect.flatMap((result) => requireSameAccountReconciliation(dependencies.sourcePlan.accountId, result)),
  )

const reconcileExact = (
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReconciliation, PaperProofError> =>
  observeReconciliation(dependencies).pipe(Effect.flatMap(requireExactReconciliation))

const reconcileExactBounded = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReconciliation, PaperProofError> =>
  observeReconciliationBounded(command, dependencies).pipe(Effect.flatMap(requireExactReconciliation))

const currentInstantBounded = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  operation: PaperProofError['operation'],
  message: string,
): Effect.Effect<string, PaperProofError> =>
  boundedLift(command, operation, message, dependencies.currentUtcInstant)

const restrictBounded = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  reason: string,
): Effect.Effect<void, PaperProofError> =>
  currentInstantBounded(command, dependencies, 'RESTRICT', 'paper proof restriction clock failed').pipe(
    Effect.flatMap((updatedAt) =>
      boundedLift(
        command,
        'RESTRICT',
        'paper proof failed to restrict mutation authority',
        dependencies.restrictAuthority(reason.slice(0, 240), updatedAt),
      ),
    ),
  )

const recoveryIdentity = (dependencies: PaperProofDependencies) => ({
  proofPlanHash: dependencies.sourcePlan.proofPlanHash,
  intentId: dependencies.sourcePlan.intentId,
})

const readRecoveryRequired = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofRecoveryRequired | undefined, PaperProofError> =>
  boundedLift(
    command,
    command.operation,
    'paper proof durable recovery read failed',
    dependencies.recovery.readRequired(recoveryIdentity(dependencies)),
  )

const armRecovery = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  operation: MutationOperation,
  reason: string,
): Effect.Effect<PaperProofRecoveryRequired, PaperProofError> =>
  Effect.gen(function* () {
    const requiredAt = yield* currentInstantBounded(
      command,
      dependencies,
      command.operation,
      'paper proof recovery requirement clock failed',
    )
    const requirement: PaperProofRecoveryRequired = {
      schemaVersion: 'bayn.paper-proof-recovery-required.v1',
      proofPlanHash: dependencies.sourcePlan.proofPlanHash,
      qualificationRunId: dependencies.sourcePlan.qualificationRunId,
      intentId: dependencies.sourcePlan.intentId,
      operation,
      reason: reason.slice(0, 240),
      requiredAt,
    }
    yield* boundedLift(
      command,
      command.operation,
      'paper proof failed to persist recovery-required evidence',
      dependencies.recovery.require(requirement),
    )
    return requirement
  })

const resolveRecovery = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  reconciliation: PaperProofReconciliation,
): Effect.Effect<void, PaperProofError> =>
  currentInstantBounded(
    command,
    dependencies,
    command.operation,
    'paper proof recovery resolution clock failed',
  ).pipe(
    Effect.flatMap((resolvedAt) =>
      boundedLift(
        command,
        command.operation,
        'paper proof failed to resolve recovery-required evidence',
        dependencies.recovery.resolve({
          proofPlanHash: dependencies.sourcePlan.proofPlanHash,
          qualificationRunId: dependencies.sourcePlan.qualificationRunId,
          intentId: dependencies.sourcePlan.intentId,
          resolvedAt,
          reconciliationId: reconciliation.reconciliationId,
          reconciliationContentHash: reconciliation.contentHash,
        }),
      ),
    ),
  )

const attemptTypedFailureContainment = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  reason: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.exit(restrictBounded(command, dependencies, reason))
    yield* Effect.exit(observeReconciliationBounded(command, dependencies))
  })

const withTypedFailureContainment = <A>(
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  reason: string,
  effect: Effect.Effect<A, PaperProofError>,
): Effect.Effect<A, PaperProofError> =>
  effect.pipe(
    Effect.catch((cause) =>
      attemptTypedFailureContainment(command, dependencies, reason).pipe(
        Effect.andThen(Effect.fail(cause)),
      ),
    ),
  )

const successfulSubmit = (event: MutationEvent): boolean =>
  event.operation === MutationOperation.Submit &&
  (event.eventType === MutationEventType.SubmitAccepted ||
    event.eventType === MutationEventType.RecoveryFound)

const terminalSubmit = (event: MutationEvent): boolean =>
  successfulSubmit(event) ||
  event.eventType === MutationEventType.SubmitRejected ||
  event.eventType === MutationEventType.SubmitDenied

const neutralizedSubmit = (event: MutationEvent): boolean =>
  event.operation === MutationOperation.Submit &&
  (event.eventType === MutationEventType.SubmitRejected ||
    event.eventType === MutationEventType.SubmitDenied)

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

const readMutation = (
  operation: MutationOperation,
  label: PaperProofError['operation'],
  dependencies: PaperProofDependencies,
): Effect.Effect<MutationEvent | undefined, PaperProofError> =>
  lift(
    label,
    `paper proof durable ${operation} read failed`,
    dependencies.mutations.latest(dependencies.sourcePlan.intentId, operation),
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
        `paper proof lookup-only ${operation} recovery failed`,
        dependencies.execution.recover(dependencies.sourcePlan.intentId, operation),
      ),
    ),
  )

const cancelOrRecover = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<MutationEvent, PaperProofError> =>
  Effect.gen(function* () {
    const existing = yield* readMutation(MutationOperation.Cancel, 'CANCEL', dependencies)
    const event =
      existing ??
      (yield* lift(
        'CANCEL',
        'paper proof identified cancellation failed',
        dependencies.execution.cancel(dependencies.sourcePlan.intentId, command.consistencyDelayMs),
      ))
    return recoveredCancellation(event)
      ? event
      : yield* recoverMutation(command, dependencies, MutationOperation.Cancel)
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

const runNewSubmit = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  prepared: PreparedPaperProofIntent,
  before: PaperProofReconciliation,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  requireExactReconciliation(before).pipe(
    Effect.andThen(
      armRecovery(
        command,
        dependencies,
        MutationOperation.Submit,
        'paper-proof-submit-recovery-required',
      ),
    ),
    Effect.andThen(
      withTypedFailureContainment(
        command,
        dependencies,
        'paper-proof-submit-post-activation-failure',
        Effect.gen(function* () {
          yield* lift(
            'SUBMIT',
            'paper proof generation activation failed',
            dependencies.activateCapitalGrant(proofBinding(command)),
          )
          const afterActivation = yield* reconcileExact(dependencies)
          const event = yield* lift(
            'SUBMIT',
            'paper proof guarded submit failed',
            dependencies.execution.submit(prepared.intentId, command.consistencyDelayMs),
          )
          if (successfulSubmit(event)) {
            const finalReconciliation = yield* reconcileExact(dependencies)
            return yield* completeReceipt(command, dependencies, {
              clientOrderId: prepared.clientOrderId,
              mutation: event,
              reconciliations: [before, afterActivation, finalReconciliation],
              restricted: false,
            })
          }
          yield* restrictBounded(
            command,
            dependencies,
            `paper-proof-submit-${event.eventType.toLowerCase()}`,
          )
          const finalReconciliation = yield* reconcileExactBounded(command, dependencies)
          if (neutralizedSubmit(event)) {
            yield* resolveRecovery(command, dependencies, finalReconciliation)
          }
          return yield* completeReceipt(command, dependencies, {
            clientOrderId: prepared.clientOrderId,
            mutation: event,
            reconciliations: [before, afterActivation, finalReconciliation],
            restricted: true,
          })
        }),
      ),
    ),
  )

const runExistingSubmit = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  prepared: PreparedPaperProofIntent,
  before: PaperProofReconciliation,
  existing: MutationEvent,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    const currentRequirement = yield* readRecoveryRequired(command, dependencies)
    const requirement =
      currentRequirement ??
      (terminalSubmit(existing)
        ? undefined
        : yield* armRecovery(
            command,
            dependencies,
            MutationOperation.Submit,
            'paper-proof-existing-submit-recovery-required',
          ))
    const event = terminalSubmit(existing)
      ? existing
      : yield* recoverMutation(command, dependencies, MutationOperation.Submit)
    let restricted = false
    let finalReconciliation: PaperProofReconciliation
    if (requirement !== undefined || !successfulSubmit(event)) {
      yield* restrictBounded(
        command,
        dependencies,
        `paper-proof-submit-${event.eventType.toLowerCase()}`,
      )
      restricted = true
      finalReconciliation = yield* reconcileExactBounded(command, dependencies)
      if (requirement !== undefined && neutralizedSubmit(event)) {
        yield* resolveRecovery(command, dependencies, finalReconciliation)
      }
    } else {
      finalReconciliation = yield* reconcileExact(dependencies)
    }
    return yield* completeReceipt(command, dependencies, {
      clientOrderId: prepared.clientOrderId,
      mutation: event,
      reconciliations: [before, finalReconciliation],
      restricted,
    })
  })

const runSubmit = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    const before = yield* observeReconciliation(dependencies)
    const prepared = yield* prepareSubmitIntent(dependencies)
    const existing = yield* readMutation(MutationOperation.Submit, 'SUBMIT', dependencies)
    return yield* (existing === undefined
      ? runNewSubmit(command, dependencies, prepared, before)
      : runExistingSubmit(command, dependencies, prepared, before, existing))
  })

const runCancel = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    const before = yield* observeReconciliation(dependencies)
    yield* armRecovery(
      command,
      dependencies,
      MutationOperation.Cancel,
      'paper-proof-cancel-recovery-required',
    )
    return yield* withTypedFailureContainment(
      command,
      dependencies,
      'paper-proof-cancel-failure',
      Effect.gen(function* () {
        const event = yield* cancelOrRecover(command, dependencies)
        yield* restrictBounded(
          command,
          dependencies,
          `paper-proof-cancel-${event.eventType.toLowerCase()}`,
        )
        const after = yield* reconcileExactBounded(command, dependencies)
        if (recoveredCancellation(event)) {
          yield* resolveRecovery(command, dependencies, after)
        }
        return yield* completeReceipt(command, dependencies, {
          mutation: event,
          reconciliations: [before, after],
          restricted: true,
        })
      }),
    )
  })

const deriveRecoveryRequirement = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofRecoveryRequired, PaperProofError> =>
  Effect.gen(function* () {
    const cancellation = yield* readMutation(MutationOperation.Cancel, 'RECOVER', dependencies)
    if (cancellation !== undefined) {
      return yield* armRecovery(
        command,
        dependencies,
        MutationOperation.Cancel,
        'paper-proof-cancel-recovery-reconstructed',
      )
    }
    return yield* armRecovery(
      command,
      dependencies,
      MutationOperation.Submit,
      'paper-proof-submit-recovery-reconstructed',
    )
  })

const recoverRequiredMutation = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
  requirement: PaperProofRecoveryRequired,
): Effect.Effect<MutationEvent | undefined, PaperProofError> =>
  Effect.gen(function* () {
    const existing = yield* readMutation(requirement.operation, 'RECOVER', dependencies)
    if (existing === undefined) return undefined
    if (requirement.operation === MutationOperation.Cancel && recoveredCancellation(existing)) {
      return existing
    }
    if (requirement.operation === MutationOperation.Submit && terminalSubmit(existing)) {
      return existing
    }
    return yield* recoverMutation(command, dependencies, requirement.operation)
  })

const recoveryIsNeutralized = (
  requirement: PaperProofRecoveryRequired,
  event: MutationEvent | undefined,
): boolean =>
  event === undefined ||
  (requirement.operation === MutationOperation.Cancel && recoveredCancellation(event)) ||
  (requirement.operation === MutationOperation.Submit && neutralizedSubmit(event))

const runRecover = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> =>
  Effect.gen(function* () {
    const currentRequirement = yield* readRecoveryRequired(command, dependencies)
    const requirement = currentRequirement ?? (yield* deriveRecoveryRequirement(command, dependencies))
    yield* restrictBounded(command, dependencies, 'paper-proof-recover-authority-restriction')
    const event = yield* recoverRequiredMutation(command, dependencies, requirement)
    const reconciliation = yield* reconcileExactBounded(command, dependencies)
    if (recoveryIsNeutralized(requirement, event)) {
      yield* resolveRecovery(command, dependencies, reconciliation)
    }
    return yield* completeReceipt(command, dependencies, {
      ...(event === undefined ? {} : { mutation: event }),
      reconciliations: [reconciliation],
      restricted: true,
    })
  })

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
