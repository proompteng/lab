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

export interface ExecutionProgramDependencies {
  readonly brokerRead: BrokerReadShape
  readonly brokerMutation: BrokerMutationShape
  readonly intentStore: IntentStoreService
  readonly mutationStore: MutationStoreShape
  readonly writerFence: WriterFenceService
  readonly liveCapitalGrants: Pick<LiveCapitalGrantStoreShape, 'lockForSubmit' | 'read'>
  readonly freshBrokerPrice: (symbol: string) => Effect.Effect<FreshBrokerQuote, OperationalError>
  readonly currentUtcInstant: Effect.Effect<string>
  /**
   * The activation lease is checked at the final writer fence, immediately before
   * broker transmission. This keeps a long-lived runtime from inheriting startup
   * PAPER authority after the reviewed activation request has expired.
   */
  readonly paperEpisodeExpiresAt?: string
  /** Close-only intents may finish recovery after the entry lease expires. */
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
  if (capital._tag !== CapitalAuthorityKind.LiveGrant) return Effect.succeed(undefined)
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

export const authorizeFinalBrokerSubmit = <A, E, R>(
  authority: MutationExecutionAuthority,
  intent: Intent,
  transmit: Effect.Effect<A, E, R>,
  dependencies: ExecutionProgramDependencies,
): Effect.Effect<A, E | FinalSubmitAuthorizationFailure, R> => {
  let transmissionStarted = false
  const lease = Effect.gen(function* () {
    const observedAt = yield* dependencies.currentUtcInstant
    const expiresAt = dependencies.paperEpisodeExpiresAt
    if (expiresAt === undefined || observedAt < expiresAt) return true
    const closeIntent = dependencies.isPaperEpisodeCloseIntent
      ? yield* dependencies.isPaperEpisodeCloseIntent(intent.intentId)
      : false
    if (!closeIntent) {
      return yield* Effect.fail({ _tag: 'PaperEpisodeExpired' as const, expiresAt, observedAt })
    }
    return true
  })
  return lease.pipe(
    Effect.andThen(
      dependencies.writerFence.transaction(
        Effect.gen(function* () {
          yield* dependencies.mutationStore.authorizeSubmit(intent.intentId)
          yield* validateFinalSubmitRisk(intent.intentId, dependencies)
          const persisted = yield* finalLiveGrantAuthorization(authority, dependencies)
          yield* validateFinalSubmitRisk(intent.intentId, dependencies)
          if (persisted !== undefined) {
            yield* finalLiveBrokerAuthorization(authority, persisted, intent, dependencies)
            yield* validateFinalSubmitRisk(intent.intentId, dependencies)
          }
          transmissionStarted = true
          return yield* transmit
        }),
      ),
    ),
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

export const makeExecutionProgram = (authority: ExecutionAuthority, dependencies: ExecutionProgramDependencies) => {
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
  return Result.succeed({
    _tag: 'ExecutionProgram' as const,
    schemaVersion: 'bayn.execution-program.v1' as const,
    authority,
    dryRunSubmit: (intentId: string) => provideCoordinatorDependencies(dryRunSubmit(intentId), coordinatorDependencies),
    submit: (intentId: string, consistencyDelayMs: number) =>
      provideCoordinatorDependencies(submit(intentId, consistencyDelayMs), coordinatorDependencies),
    cancel: (intentId: string, consistencyDelayMs: number) =>
      provideCoordinatorDependencies(cancel(intentId, consistencyDelayMs), coordinatorDependencies),
    recover: (intentId: string, operation: MutationOperation) =>
      provideCoordinatorDependencies(recover(intentId, operation), coordinatorDependencies),
  })
}

export type ExecutionProgram = Result.Result.Success<ReturnType<typeof makeExecutionProgram>>
