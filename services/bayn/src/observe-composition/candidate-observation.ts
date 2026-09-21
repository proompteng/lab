import { Context, Effect, Result } from 'effect'

import { operationalError, type OperationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import type { VerifiedStrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import type { IntradayMomentumTargetPortfolio } from '../strategy/intraday-momentum/model'
import type { IntradayMomentumProtocol } from '../strategy/intraday-momentum/protocol'

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

export type CandidateObservation = Result.Result.Success<ReturnType<typeof makeCandidateObservation>>

export class CandidateObservationStore extends Context.Service<
  CandidateObservationStore,
  { readonly record: (observation: CandidateObservation) => Effect.Effect<void, OperationalError> }
>()('@proompteng/bayn/observe-composition/CandidateObservationStore') {}

export const candidateObservationLog = ({ contentHash, payload }: CandidateObservation) => ({
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
})

export const recordCandidateObservation = (input: CandidateObservationInput) =>
  Effect.gen(function* () {
    const observation = yield* Effect.fromResult(makeCandidateObservation(input))
    const store = yield* CandidateObservationStore
    yield* store.record(observation)
    yield* Effect.logInfo(candidateObservationLog(observation))
  })
