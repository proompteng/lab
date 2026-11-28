import { isIntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import { Context, Effect, Option, Result } from 'effect'

import { operationalError, type OperationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import type { VerifiedStrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import type { IntradayMomentumTargetPortfolio } from '../strategy/intraday-momentum/model'
import type { IntradayMomentumProtocol } from '../strategy/intraday-momentum/protocol'
import type { makeJevObservation } from '../jev/observation'
import type { JevPurpose } from '../jev/portfolio'
import type { makeOwnedIntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import type { IntradayAlphaPolicy } from '../strategy/intraday-alpha/policy'
import type { RepeatedMomentumPolicy } from '../strategy/repeated-momentum/policy'

interface CandidateObservationInput {
  readonly cycleId: string
  readonly authorityGenerationHash: string
  readonly observedAt: string
  readonly protocol: IntradayMomentumProtocol
  readonly snapshot: VerifiedStrategyMarketSnapshot
  readonly decision: IntradayMomentumTargetPortfolio
}

export const makeCandidateObservation = (input: CandidateObservationInput) =>
  persistIntradayRecordRows(input.snapshot).pipe(
    Result.flatMap((rows) => {
      const payload = {
        schemaVersion: 'bayn.intraday-candidate-observation.v2' as const,
        cycleId: input.cycleId,
        authorityGenerationHash: input.authorityGenerationHash,
        observedAt: input.observedAt,
        protocol: input.protocol,
        manifest: input.snapshot.manifest,
        rows,
        decision: input.decision,
      }
      return canonicalHashV1Result(payload).pipe(Result.map((contentHash) => ({ contentHash, payload })))
    }),
    Result.mapError((cause) =>
      operationalError({
        component: 'database',
        operation: 'candidate-observation',
        message: 'candidate observation evidence could not be constructed',
        cause,
      }),
    ),
  )

type OwnedIntradayAlphaObservation = Result.Result.Success<ReturnType<typeof makeOwnedIntradayAlphaObservation>>

export type IntradayAlphaCandidateObservation = {
  readonly contentHash: string
  readonly payload: OwnedIntradayAlphaObservation['payload']
}

export type CandidateObservation =
  | Result.Result.Success<ReturnType<typeof makeCandidateObservation>>
  | Result.Result.Success<ReturnType<typeof makeJevObservation>>
  | IntradayAlphaCandidateObservation

export interface IntradayAlphaSessionState {
  readonly morningOrbTakenSymbols: readonly string[]
  readonly middayReversionCompleted: boolean
  readonly noiseAreaTakenSymbols?: readonly string[]
}

export class CandidateObservationStore extends Context.Service<
  CandidateObservationStore,
  {
    readonly record: (
      observation: CandidateObservation,
      policy?: RepeatedMomentumPolicy | IntradayAlphaPolicy,
    ) => Effect.Effect<void, OperationalError>
    // Entry consumption follows the standing policy across cycles; management stays with its owning cycle.
    readonly latestJevWindowEnd: (input: {
      readonly cycleId: string
      readonly purpose: JevPurpose
      readonly schemaVersion?:
        | 'bayn.jev-observation.v1'
        | 'bayn.intraday-alpha-observation.v1'
        | 'bayn.intraday-alpha-observation.v2'
        | 'bayn.intraday-alpha-observation.v3'
    }) => Effect.Effect<Option.Option<string>, OperationalError>
    readonly readIntradayAlphaSessionState?: (input: {
      readonly cycleId: string
      readonly accountId: string
      readonly sessionDate: string
      readonly strategyProtocolHash: string
    }) => Effect.Effect<IntradayAlphaSessionState, OperationalError>
  }
>()('@proompteng/bayn/observe-composition/CandidateObservationStore') {}

export const candidateObservationLog = ({ contentHash, payload }: CandidateObservation) =>
  payload.schemaVersion === 'bayn.jev-observation.v1'
    ? {
        event: payload.schemaVersion,
        contentHash,
        cycleId: payload.cycleId,
        authorityGenerationHash: payload.authorityGenerationHash,
        observedAt: payload.observedAt,
        snapshotId: payload.manifest.snapshotId,
        purpose: payload.portfolio.purpose,
        candidates: payload.manifest.candidateSymbols,
        excludedCandidates: payload.manifest.candidateExclusions?.map(({ symbol, reason }) => ({ symbol, reason })),
      }
    : isIntradayAlphaObservation(payload)
      ? {
          event: payload.schemaVersion,
          contentHash,
          cycleId: payload.cycleId,
          authorityGenerationHash: payload.authorityGenerationHash,
          observedAt: payload.observedAt,
          snapshotId: payload.manifest['snapshotId'],
          purpose: payload.portfolio.purpose,
          candidates: payload.manifest['candidateSymbols'],
          excludedCandidates: payload.manifest['candidateExclusions'],
        }
      : {
          event: payload.schemaVersion,
          contentHash,
          cycleId: payload.cycleId,
          authorityGenerationHash: payload.authorityGenerationHash,
          observedAt: payload.observedAt,
          snapshotId: payload.manifest.snapshotId,
          snapshotContentHash: payload.manifest.contentHash,
          selectedSymbols: payload.decision.selectedSymbols,
          candidates: payload.decision.signals.map(({ symbol, eligible, rejectionReasons }) => ({
            symbol,
            eligible,
            rejectionReasons,
          })),
          excludedCandidates: payload.decision.excludedCandidates.map(({ symbol, reason }) => ({ symbol, reason })),
        }

export const recordCandidateObservation = (input: CandidateObservationInput) =>
  Effect.gen(function* () {
    const observation = yield* Effect.fromResult(makeCandidateObservation(input))
    const store = yield* CandidateObservationStore
    yield* store.record(observation)
    yield* Effect.logInfo(candidateObservationLog(observation))
  })
