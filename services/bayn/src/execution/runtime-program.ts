import { Clock, Effect, Result } from 'effect'

import { BrokerRead, type BrokerReadShape } from '../broker/alpaca'
import { BrokerMutation, type BrokerMutationShape } from '../broker/alpaca-mutations'
import { unknownOutcome } from '../broker/alpaca-mutations/model'
import type { LiveCapitalGrantStoreShape } from '../db/live-capital-grant'
import type { OperationalError } from '../errors'
import { MutationOperation } from '../broker/alpaca-mutations'
import { cancel, dryRunSubmit, recover, submit } from './coordinator'
import { selectStoredIntent, validateStartedSubmitRiskDecision } from './coordinator-decisions'
import type { Intent } from './contracts'
import {
  BrokerAccess,
  CapitalAuthorityKind,
  type ExecutionAuthority,
  type LiveCapitalAuthority,
  type MutationExecutionAuthority,
} from './authority'
import { IntentStore, type IntentStoreService } from './intents'
import { MutationStore, type MutationStoreShape } from './mutations'
import {
  makeAuthorityGuardedBrokerMutation,
  isLiveMutationExecutionAuthority,
  refreshLiveBrokerSubmitSnapshot,
  validateLiveBrokerSubmitSnapshot,
  validateLiveGrantForSubmit,
  type FinalSubmitAuthorizationFailure,
  type FreshBrokerQuote,
} from './mutation-authority'
import { WriterFence, WriterFenceError, type WriterFenceService } from './writer-fence'
import { Pipeable } from '../pipeable'

export interface ExecutionProgramDependencies {
  readonly brokerRead: BrokerReadShape
  readonly brokerMutation: BrokerMutationShape
  readonly intentStore: IntentStoreService
  readonly mutationStore: MutationStoreShape
  readonly writerFence: WriterFenceService
  readonly liveCapitalGrants: Pick<LiveCapitalGrantStoreShape, 'lockForSubmit' | 'read'>
  readonly freshBrokerPrice: (symbol: string) => Effect.Effect<FreshBrokerQuote, OperationalError>
  readonly currentUtcInstant: Effect.Effect<string>
  /** The reviewed PAPER entry lease, checked at the final writer fence. */
  readonly paperEpisodeEntryExpiresAt?: string
  /** Close-only intents may finish recovery until this separate close lease expires. */
  readonly paperEpisodeCloseExpiresAt?: string
  readonly isPaperEpisodeCloseIntent?: (intentId: string) => Effect.Effect<boolean>
}

export interface ExecutionProgramConstructionFailure {
  readonly _tag: 'ExecutionProgramRequiresMutationAuthority'
  readonly brokerAccess: BrokerAccess
}

const finalLiveGrantAuthorization = (
  authority: MutationExecutionAuthority,
  dependencies: ExecutionProgramDependencies,
): Effect.Effect<LiveCapitalAuthority | undefined, FinalSubmitAuthorizationFailure> => {
  const capital = authority.capitalAuthority
  if (capital._tag !== CapitalAuthorityKind.LiveGrant) return Effect.as(Effect.void, undefined)
  const grantHash = capital.grant.grantHash
  return Effect.gen(function* () {
    const persisted = yield* dependencies.liveCapitalGrants.lockForSubmit(grantHash)
    if (persisted === undefined) {
      return yield* Effect.fail({ _tag: 'LiveCapitalGrantMissing' as const, grantHash })
    }
    const observedAt = yield* dependencies.currentUtcInstant
    const validated = validateLiveGrantForSubmit(authority, persisted, observedAt)
    if (Result.isFailure(validated)) return yield* Effect.fail(validated.failure)
    return persisted
  })
}

const finalLiveBrokerAuthorization = (
  authority: MutationExecutionAuthority,
  persisted: LiveCapitalAuthority,
  intent: Intent,
  dependencies: ExecutionProgramDependencies,
): Effect.Effect<void, FinalSubmitAuthorizationFailure> => {
  if (!isLiveMutationExecutionAuthority(authority)) {
    return Effect.fail({ _tag: 'FreshAuthorityCapabilityMismatch' as const })
  }
  return Effect.gen(function* () {
    const snapshot = yield* refreshLiveBrokerSubmitSnapshot(authority, intent, dependencies)
    const observedAt = yield* dependencies.currentUtcInstant
    const validation = validateLiveBrokerSubmitSnapshot(authority, persisted, intent, snapshot, observedAt)
    if (Result.isFailure(validation)) return yield* Effect.fail(validation.failure)
  })
}

const validateFinalSubmitRisk = (intentId: string, dependencies: ExecutionProgramDependencies) =>
  dependencies.intentStore.read(intentId).pipe(
    Effect.flatMap((stored) => Effect.fromResult(selectStoredIntent(MutationOperation.Submit, intentId, stored))),
    Effect.flatMap((stored) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((currentTimeMillis) =>
          Effect.fromResult(validateStartedSubmitRiskDecision(stored, currentTimeMillis)),
        ),
      ),
    ),
    Effect.asVoid,
  )

const validatePaperEpisodeLease = (
  intentId: string,
  dependencies: ExecutionProgramDependencies,
  closeIntent?: boolean,
): Effect.Effect<void, FinalSubmitAuthorizationFailure> =>
  Effect.gen(function* () {
    if (
      dependencies.paperEpisodeEntryExpiresAt === undefined &&
      dependencies.paperEpisodeCloseExpiresAt === undefined
    ) {
      return
    }
    const isCloseIntent =
      closeIntent ??
      (dependencies.isPaperEpisodeCloseIntent !== undefined
        ? yield* dependencies.isPaperEpisodeCloseIntent(intentId)
        : false)
    const expiresAt = isCloseIntent ? dependencies.paperEpisodeCloseExpiresAt : dependencies.paperEpisodeEntryExpiresAt
    if (expiresAt === undefined) return
    const observedAt = yield* dependencies.currentUtcInstant
    if (observedAt < expiresAt) return
    return yield* Effect.fail({ _tag: 'PaperEpisodeExpired' as const, expiresAt, observedAt })
  })

export const authorizeFinalBrokerSubmit = <A, E, R>(
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
          dependencies.isPaperEpisodeCloseIntent !== undefined
            ? yield* dependencies.isPaperEpisodeCloseIntent(intent.intentId)
            : false
        yield* dependencies.mutationStore.authorizeSubmit(intent.intentId, closeOnly)
        yield* validateFinalSubmitRisk(intent.intentId, dependencies)
        const persisted = yield* finalLiveGrantAuthorization(authority, dependencies)
        yield* validateFinalSubmitRisk(intent.intentId, dependencies)
        if (persisted !== undefined) {
          yield* finalLiveBrokerAuthorization(authority, persisted, intent, dependencies)
          yield* validateFinalSubmitRisk(intent.intentId, dependencies)
        }
        yield* validatePaperEpisodeLease(intent.intentId, dependencies, closeOnly)
        transmissionStarted = true
        return yield* transmit
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        transmissionStarted && cause instanceof WriterFenceError
          ? unknownOutcome(
              MutationOperation.Submit,
              'final submit transaction failed after broker transmission began',
              undefined,
              undefined,
              cause,
            )
          : cause,
      ),
    )
}

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
      ...dependencies,
      finalSubmitAuthorization: (intent, transmit) =>
        authorizeFinalBrokerSubmit(mutationAuthority, intent, transmit, dependencies),
    }),
  }
  const isPaperEpisodeCloseIntent = (intentId: string) =>
    dependencies.isPaperEpisodeCloseIntent === undefined
      ? Effect.succeed(false)
      : dependencies.isPaperEpisodeCloseIntent(intentId)
  return Result.succeed({
    _tag: 'ExecutionProgram' as const,
    schemaVersion: 'bayn.execution-program.v1' as const,
    authority,
    dryRunSubmit: (intentId: string) => provideCoordinatorDependencies(dryRunSubmit(intentId), coordinatorDependencies),
    submit: (intentId: string, consistencyDelayMs: number) =>
      isPaperEpisodeCloseIntent(intentId).pipe(
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
