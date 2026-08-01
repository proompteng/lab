import { Clock, Duration, Effect, Exit } from 'effect'

import { MutationOperation } from '../broker/alpaca-mutations'
import type { MutationEvent } from '../execution/mutations'
import { utcInstantFromEpochMillis } from '../time'
import {
  runPaperProofCancel,
  runPaperProofSubmit,
  type PaperProofCancelDependencies,
  type PaperProofSubmitDependencies,
} from './mutations'
import { runPaperProofPrepare, type PaperProofPrepareDependencies } from './prepare'
import { runPaperProofRecover, type PaperProofRecoverDependencies } from './recovery'
import { hasPaperProofMutationAuthority, paperProofContainmentIoCount, validatePaperProofEntry } from './gates'
import {
  liftBounded,
  validateReconciliationAccount,
  type PaperProofContainmentDependencies,
  type PaperProofMutationStore,
} from './operations'
import {
  PaperProofError,
  type PaperProofCommand,
  type PaperProofReceipt,
  type PaperProofRecoveryStore,
  type PaperProofRuntimeBinding,
  type PaperProofSourcePlan,
} from './model'

const malformedCommandContainmentIoTimeoutMs = 5_000
const malformedCommandContainmentTotalTimeoutMs = 20_000

interface PaperProofContainmentContext {
  readonly operation: PaperProofError['operation']
  readonly containmentIoTimeoutMs: number
}

type PaperProofSubmitCompositionDependencies = Omit<
  PaperProofSubmitDependencies,
  'currentUtcInstant' | 'execution' | 'mutations' | 'reconcile' | 'recovery' | 'restrictAuthority'
> & {
  readonly execution: Omit<PaperProofSubmitDependencies['execution'], 'recover'>
}

type PaperProofCancelCompositionDependencies = Omit<
  PaperProofCancelDependencies,
  'currentUtcInstant' | 'execution' | 'mutations' | 'readIntent' | 'reconcile' | 'recovery' | 'restrictAuthority'
> & {
  readonly execution: Omit<PaperProofCancelDependencies['execution'], 'recover'>
}

type PaperProofRecoverCompositionDependencies = Omit<
  PaperProofRecoverDependencies,
  'currentUtcInstant' | 'execution' | 'mutations' | 'readIntent' | 'reconcile' | 'recovery' | 'restrictAuthority'
>

/**
 * Composition owns all live capabilities, but each operation receives only its nested capability surface. The
 * operation programs never receive runtime authority, the protected token, or another operation's broker adapter.
 */
export interface PaperProofDependencies {
  readonly sourcePlan: PaperProofSourcePlan
  readonly runtime: PaperProofRuntimeBinding
  readonly protectedEntryToken: string
  readonly containment: PaperProofContainmentDependencies
  /** Stateful mutation evidence is canonical and shared by every mutation operation view. */
  readonly mutations: PaperProofMutationStore
  /** Stateful recovery markers are canonical and shared by every mutation operation view. */
  readonly recovery: PaperProofRecoveryStore
  /** Durable intent state is canonical and shared by cancellation and recovery views. */
  readonly readIntent: PaperProofCancelDependencies['readIntent']
  /** Broker recovery lookup is canonical and shared by the original mutation and RECOVER views. */
  readonly recoverMutation: (intentId: string, operation: MutationOperation) => Effect.Effect<MutationEvent, Error>
  readonly prepare: Omit<PaperProofPrepareDependencies, 'currentUtcInstant' | 'reconcile'>
  readonly submit: PaperProofSubmitCompositionDependencies
  readonly cancel: PaperProofCancelCompositionDependencies
  readonly recover: PaperProofRecoverCompositionDependencies
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
  accountId: string,
  dependencies: PaperProofContainmentDependencies,
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
      ? yield* Clock.currentTimeMillis.pipe(Effect.map((millis) => utcInstantFromEpochMillis(millis)))
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
      ).pipe(Effect.flatMap((result) => Effect.fromResult(validateReconciliationAccount(accountId, result)))),
    )
    yield* logContainmentFailure(context.operation, 'reconcile', reconciliationExit)
  })

const withRecoveryFinalizer = <A>(
  command: PaperProofContainmentContext,
  accountId: string,
  dependencies: PaperProofContainmentDependencies,
  reason: string,
  effect: Effect.Effect<A, PaperProofError>,
): Effect.Effect<A, PaperProofError> =>
  effect.pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit) ? containFailure(command, accountId, dependencies, reason) : Effect.void,
    ),
  )

export const containMalformedPaperProofCommand = (
  operation: PaperProofCommand['operation'] | 'GATE',
  accountId: string,
  dependencies: PaperProofContainmentDependencies,
  failure: PaperProofError,
): Effect.Effect<never, PaperProofError> =>
  withRecoveryFinalizer(
    {
      operation,
      containmentIoTimeoutMs: malformedCommandContainmentIoTimeoutMs,
    },
    accountId,
    dependencies,
    'paper-proof-malformed-command-envelope',
    Effect.fail(failure),
  ).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(malformedCommandContainmentTotalTimeoutMs),
      orElse: () =>
        Effect.fail(
          new PaperProofError({
            operation: 'TIMEOUT',
            failure: 'timeout',
            message: `paper proof malformed-command containment exceeded its ${malformedCommandContainmentTotalTimeoutMs.toString()}ms total bound`,
          }),
        ),
    }),
  )

const commandTimeout = (message: string): Effect.Effect<never, PaperProofError> =>
  Effect.fail(
    new PaperProofError({
      operation: 'TIMEOUT',
      failure: 'timeout',
      message,
    }),
  )

const runValidatedPaperProof = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> => {
  switch (command.operation) {
    case 'PREPARE':
      return runPaperProofPrepare(
        { command: { ...command, operation: 'PREPARE' }, sourcePlan: dependencies.sourcePlan },
        {
          ...dependencies.prepare,
          currentUtcInstant: dependencies.containment.currentUtcInstant,
          reconcile: dependencies.containment.reconcile,
        },
      )
    case 'SUBMIT':
      return withRecoveryFinalizer(
        command,
        dependencies.sourcePlan.accountId,
        dependencies.containment,
        'paper-proof-submit-failure',
        runPaperProofSubmit(
          { command: { ...command, operation: 'SUBMIT' }, sourcePlan: dependencies.sourcePlan },
          {
            ...dependencies.submit,
            currentUtcInstant: dependencies.containment.currentUtcInstant,
            mutations: dependencies.mutations,
            execution: {
              ...dependencies.submit.execution,
              recover: (intentId) => dependencies.recoverMutation(intentId, MutationOperation.Submit),
            },
            reconcile: dependencies.containment.reconcile,
            recovery: dependencies.recovery,
            restrictAuthority: dependencies.containment.restrictAuthority,
          },
        ),
      )
    case 'CANCEL':
      return withRecoveryFinalizer(
        command,
        dependencies.sourcePlan.accountId,
        dependencies.containment,
        'paper-proof-cancel-failure',
        runPaperProofCancel(
          { command: { ...command, operation: 'CANCEL' }, sourcePlan: dependencies.sourcePlan },
          {
            ...dependencies.cancel,
            currentUtcInstant: dependencies.containment.currentUtcInstant,
            mutations: dependencies.mutations,
            execution: {
              ...dependencies.cancel.execution,
              recover: (intentId) => dependencies.recoverMutation(intentId, MutationOperation.Cancel),
            },
            readIntent: dependencies.readIntent,
            reconcile: dependencies.containment.reconcile,
            recovery: dependencies.recovery,
            restrictAuthority: dependencies.containment.restrictAuthority,
          },
        ),
      )
    case 'RECOVER':
      return withRecoveryFinalizer(
        command,
        dependencies.sourcePlan.accountId,
        dependencies.containment,
        'paper-proof-recover-load-or-execution-failure',
        runPaperProofRecover(
          { command: { ...command, operation: 'RECOVER' }, sourcePlan: dependencies.sourcePlan },
          {
            ...dependencies.recover,
            currentUtcInstant: dependencies.containment.currentUtcInstant,
            mutations: dependencies.mutations,
            execution: {
              recoverSubmit: (intentId) => dependencies.recoverMutation(intentId, MutationOperation.Submit),
              recoverCancel: (intentId) => dependencies.recoverMutation(intentId, MutationOperation.Cancel),
            },
            readIntent: dependencies.readIntent,
            reconcile: dependencies.containment.reconcile,
            recovery: dependencies.recovery,
            restrictAuthority: dependencies.containment.restrictAuthority,
          },
        ),
      )
  }
}

export const runPaperProof = (
  command: PaperProofCommand,
  dependencies: PaperProofDependencies,
): Effect.Effect<PaperProofReceipt, PaperProofError> => {
  const requiresContainment = hasPaperProofMutationAuthority(dependencies.runtime)
  const executionTimeoutMs = requiresContainment
    ? command.timeoutMs - command.containmentIoTimeoutMs * paperProofContainmentIoCount
    : command.timeoutMs
  const entry = Effect.fromResult(
    validatePaperProofEntry(command, dependencies.sourcePlan, dependencies.runtime, dependencies.protectedEntryToken),
  )
  const containedEntry = requiresContainment
    ? withRecoveryFinalizer(
        command,
        dependencies.sourcePlan.accountId,
        dependencies.containment,
        'paper-proof-entry-gate-failure',
        entry,
      )
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
