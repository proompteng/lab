import { Clock, Effect, Result } from 'effect'

import { BrokerRead, type BrokerReadShape } from '../broker/alpaca'
import { BrokerMutation, type BrokerMutationShape } from '../broker/alpaca-mutations'
import { unknownOutcome } from '../broker/alpaca-mutations/model'
import type { PersistedCapitalGrantStoreShape } from '../db/persisted-capital-grant'
import { canonicalHashV1Result } from '../hash'
import type { Policy } from '../risk'
import { MutationOperation } from '../broker/alpaca-mutations'
import { cancel, dryRunSubmit, recover, submit } from './coordinator'
import { selectStoredIntent, validateStartedSubmitRiskDecision } from './coordinator-decisions'
import type { Intent } from './contracts'
import {
  BrokerAccess,
  type ExecutionCapitalLimits,
  type ExecutionAuthority,
  type GrantedCapitalAuthority,
  type MutationExecutionAuthority,
} from './authority'
import { IntentStore, type IntentStoreService, type StoredIntent } from './intents'
import { MutationStore, type MutationStoreShape } from './mutations'
import {
  makeAuthorityGuardedBrokerMutation,
  constrainExecutionCapitalLimits,
  executionCapitalLimitsFromPolicy,
  refreshExecutionBrokerSubmitSnapshot,
  validateExecutionBrokerSubmitSnapshot,
  validatePersistedCapitalGrantForSubmit,
  type FinalSubmitAuthorizationFailure,
} from './mutation-authority'
import { WriterFence, WriterFenceError, type WriterFenceService } from './writer-fence'
import { Pipeable } from '../pipeable'

export interface ExecutionProgramDependencies {
  readonly brokerRead: BrokerReadShape
  readonly brokerMutation: BrokerMutationShape
  readonly intentStore: IntentStoreService
  readonly mutationStore: MutationStoreShape
  readonly writerFence: WriterFenceService
  readonly persistedCapitalGrants: Pick<PersistedCapitalGrantStoreShape, 'lockForSubmit' | 'read'>
  readonly riskPolicy: Policy
  readonly currentUtcInstant: Effect.Effect<string>
  /** The reviewed entry lease, checked at the final writer fence. */
  readonly entrySubmitExpiresAt?: string
  /** Close-only intents may finish recovery until this separate close lease expires. */
  readonly closeSubmitExpiresAt?: string
  readonly isCloseOnlyIntent?: (intentId: string) => Effect.Effect<boolean>
}

export interface ExecutionProgramConstructionFailure {
  readonly _tag: 'ExecutionProgramRequiresMutationAuthority'
  readonly brokerAccess: BrokerAccess
}

interface FinalExecutionCapitalAuthorization {
  readonly limits: ExecutionCapitalLimits
  readonly hardCloseLimits?: Pick<ExecutionCapitalLimits, 'maxOrderNotionalMicros' | 'maxDailyLossMicros'>
  readonly persistedAuthority?: GrantedCapitalAuthority
}

const executionPolicyLimits = (
  authority: MutationExecutionAuthority,
  intent: Intent,
  dependencies: ExecutionProgramDependencies,
): Result.Result<ExecutionCapitalLimits, FinalSubmitAuthorizationFailure> => {
  const policyHash = canonicalHashV1Result(dependencies.riskPolicy)
  if (Result.isFailure(policyHash)) {
    return Result.fail({ _tag: 'ExecutionRiskPolicyInvalid' as const })
  }
  if (policyHash.success !== intent.policyHash) {
    return Result.fail({
      _tag: 'ExecutionRiskPolicyHashMismatch' as const,
      expected: intent.policyHash,
      observed: policyHash.success,
    })
  }
  if (dependencies.riskPolicy.accountId !== authority.brokerIdentity.accountId) {
    return Result.fail({
      _tag: 'ExecutionRiskPolicyAccountMismatch' as const,
      expected: authority.brokerIdentity.accountId,
      observed: dependencies.riskPolicy.accountId,
    })
  }
  return Result.succeed(executionCapitalLimitsFromPolicy(dependencies.riskPolicy))
}

const finalExecutionGrantAuthorization = (
  authority: MutationExecutionAuthority,
  intent: Intent,
  dependencies: ExecutionProgramDependencies,
): Effect.Effect<FinalExecutionCapitalAuthorization, FinalSubmitAuthorizationFailure> => {
  const policyLimits = executionPolicyLimits(authority, intent, dependencies)
  if (Result.isFailure(policyLimits)) return Effect.fail(policyLimits.failure)
  const capital = authority.capitalAuthority
  if (capital.persistedGrant === undefined) return Effect.succeed({ limits: policyLimits.success })
  const grantHash = capital.persistedGrant.grant.grantHash
  return Effect.gen(function* () {
    const persisted = yield* dependencies.persistedCapitalGrants.lockForSubmit(grantHash)
    if (persisted === undefined) {
      return yield* Effect.fail({ _tag: 'PersistedCapitalGrantMissing' as const, grantHash })
    }
    const observedAt = yield* dependencies.currentUtcInstant
    const validated = validatePersistedCapitalGrantForSubmit(authority, persisted, observedAt)
    if (Result.isFailure(validated)) return yield* Effect.fail(validated.failure)
    const grantLimits = validated.success.capitalAuthority.persistedGrant.grant.limits
    return {
      limits: constrainExecutionCapitalLimits(policyLimits.success, grantLimits),
      hardCloseLimits: grantLimits,
      persistedAuthority: persisted,
    }
  })
}

const finalBrokerAuthorization = (
  authority: MutationExecutionAuthority,
  capital: FinalExecutionCapitalAuthorization,
  intent: Intent,
  closeOnly: boolean,
  dependencies: ExecutionProgramDependencies,
): Effect.Effect<void, FinalSubmitAuthorizationFailure> => {
  return Effect.gen(function* () {
    const snapshot = yield* refreshExecutionBrokerSubmitSnapshot(capital.limits, intent, dependencies)
    const observedAt = yield* dependencies.currentUtcInstant
    const refreshedAuthority =
      capital.persistedAuthority === undefined
        ? Result.succeed(authority)
        : validatePersistedCapitalGrantForSubmit(authority, capital.persistedAuthority, observedAt)
    if (Result.isFailure(refreshedAuthority)) return yield* Effect.fail(refreshedAuthority.failure)
    const validation = validateExecutionBrokerSubmitSnapshot(
      refreshedAuthority.success,
      capital.limits,
      intent,
      snapshot,
      observedAt,
      {
        closeOnly,
        maxBrokerStateAgeMs: dependencies.riskPolicy.maxBrokerStateAgeMs,
        maxNetExposureMicros: dependencies.riskPolicy.maxNetExposureMicros,
        ...(capital.hardCloseLimits === undefined ? {} : { hardCloseLimits: capital.hardCloseLimits }),
      },
    )
    if (Result.isFailure(validation)) return yield* Effect.fail(validation.failure)
  })
}

const readFinalSubmitRisk = (intentId: string, dependencies: ExecutionProgramDependencies) =>
  dependencies.intentStore
    .read(intentId)
    .pipe(Effect.flatMap((stored) => Effect.fromResult(selectStoredIntent(MutationOperation.Submit, intentId, stored))))

const validateFinalSubmitRisk = (stored: StoredIntent) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((currentTimeMillis) =>
      Effect.fromResult(validateStartedSubmitRiskDecision(stored, currentTimeMillis)),
    ),
    Effect.asVoid,
  )

const validateExecutionWindow = (
  intentId: string,
  dependencies: ExecutionProgramDependencies,
  closeIntent?: boolean,
): Effect.Effect<void, FinalSubmitAuthorizationFailure> =>
  Effect.gen(function* () {
    if (dependencies.entrySubmitExpiresAt === undefined && dependencies.closeSubmitExpiresAt === undefined) {
      return
    }
    const isCloseIntent =
      closeIntent ??
      (dependencies.isCloseOnlyIntent !== undefined ? yield* dependencies.isCloseOnlyIntent(intentId) : false)
    const expiresAt = isCloseIntent ? dependencies.closeSubmitExpiresAt : dependencies.entrySubmitExpiresAt
    if (expiresAt === undefined) return
    const observedAt = yield* dependencies.currentUtcInstant
    if (observedAt < expiresAt) return
    return yield* Effect.fail({ _tag: 'ExecutionWindowExpired' as const, expiresAt, observedAt })
  })

const authorizeFinalBrokerSubmitDataFirst = <A, E, R>(
  authority: MutationExecutionAuthority,
  intent: Intent,
  transmit: Effect.Effect<A, E, R>,
  dependencies: ExecutionProgramDependencies,
): Effect.Effect<A, E | FinalSubmitAuthorizationFailure, R> => {
  let transmissionStarted = false
  return dependencies.writerFence
    .transaction(
      Effect.gen(function* () {
        const closeOnly =
          dependencies.isCloseOnlyIntent !== undefined ? yield* dependencies.isCloseOnlyIntent(intent.intentId) : false
        yield* dependencies.mutationStore.authorizeSubmit(intent.intentId, closeOnly)
        // The writer-fence transaction owns Bayn's PostgreSQL writer for this interval, so the started intent bytes are
        // stable until commit. Reuse them and re-evaluate only the time-bound risk decision after broker I/O.
        const startedIntent = yield* readFinalSubmitRisk(intent.intentId, dependencies)
        yield* validateFinalSubmitRisk(startedIntent)
        const capital = yield* finalExecutionGrantAuthorization(authority, intent, dependencies)
        yield* validateFinalSubmitRisk(startedIntent)
        yield* validateExecutionWindow(intent.intentId, dependencies, closeOnly)
        yield* finalBrokerAuthorization(authority, capital, intent, closeOnly, dependencies)
        yield* validateFinalSubmitRisk(startedIntent)
        yield* validateExecutionWindow(intent.intentId, dependencies, closeOnly)
        transmissionStarted = true
        return yield* transmit
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        transmissionStarted && cause instanceof WriterFenceError
          ? unknownOutcome({
              operation: MutationOperation.Submit,
              message: 'final submit transaction failed after broker transmission began',
              cause,
            })
          : cause,
      ),
    )
}

export const authorizeFinalBrokerSubmit = Pipeable.generic<
  <A, E, R>(
    intent: Intent,
    transmit: Effect.Effect<A, E, R>,
    dependencies: ExecutionProgramDependencies,
  ) => (authority: MutationExecutionAuthority) => Effect.Effect<A, E | FinalSubmitAuthorizationFailure, R>,
  typeof authorizeFinalBrokerSubmitDataFirst
>(4, authorizeFinalBrokerSubmitDataFirst)

const provideCoordinatorDependencies = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  dependencies: ExecutionProgramDependencies,
) =>
  effect.pipe(
    Effect.provideService(BrokerRead, dependencies.brokerRead),
    Effect.provideService(BrokerMutation, dependencies.brokerMutation),
    Effect.provideService(IntentStore, dependencies.intentStore),
    Effect.provideService(MutationStore, dependencies.mutationStore),
    Effect.provideService(WriterFence, dependencies.writerFence),
  )

const makeExecutionProgramDataFirst = (authority: ExecutionAuthority, dependencies: ExecutionProgramDependencies) => {
  if (authority.brokerAccess !== BrokerAccess.Mutation) {
    return Result.fail({
      _tag: 'ExecutionProgramRequiresMutationAuthority' as const,
      brokerAccess: authority.brokerAccess,
    })
  }
  const mutationAuthority: MutationExecutionAuthority = authority
  const coordinatorDependencies: ExecutionProgramDependencies = {
    ...dependencies,
    brokerMutation: makeAuthorityGuardedBrokerMutation(authority, {
      brokerMutation: dependencies.brokerMutation,
      finalSubmitAuthorization: (intent, transmit) =>
        authorizeFinalBrokerSubmit(mutationAuthority, intent, transmit, dependencies),
    }),
  }
  const isCloseOnlyIntent = (intentId: string) =>
    dependencies.isCloseOnlyIntent === undefined ? Effect.succeed(false) : dependencies.isCloseOnlyIntent(intentId)
  return Result.succeed({
    _tag: 'ExecutionProgram' as const,
    schemaVersion: 'bayn.execution-program.v1' as const,
    authority,
    dryRunSubmit: (intentId: string) => provideCoordinatorDependencies(dryRunSubmit(intentId), coordinatorDependencies),
    submit: (intentId: string, consistencyDelayMs: number) =>
      isCloseOnlyIntent(intentId).pipe(
        Effect.flatMap((closeOnly) =>
          provideCoordinatorDependencies(submit(intentId, consistencyDelayMs, closeOnly), coordinatorDependencies),
        ),
      ),
    cancel: (intentId: string, consistencyDelayMs: number) =>
      provideCoordinatorDependencies(cancel(intentId, consistencyDelayMs), coordinatorDependencies),
    recover: (intentId: string, operation: MutationOperation) =>
      provideCoordinatorDependencies(recover(intentId, operation), coordinatorDependencies),
  })
}

export const makeExecutionProgram = Pipeable.dual(2, makeExecutionProgramDataFirst)

export type ExecutionProgram = Result.Result.Success<ReturnType<typeof makeExecutionProgram>>
