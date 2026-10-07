import { Result } from 'effect'

import type { MarketCalendarObservation } from '../broker/alpaca/model'
import { canonicalHashV1Result } from '../hash'
import type { IntradaySnapshotQuery } from '../market-data/intraday/model'
import type { HistoricalMarketCursor } from '../market-data/streaming/historical'
import { utcInstantFromEpochMillis } from '../time'
import { featureRowFromObservation, isCandidateExclusion } from './control-ridge'
import { extractSixBarResearchObservation, sixBarResearchDefinition, SixBarResearchStatus } from './six-bar-features'

/** One fixed candidate's causal, serial training behavior; this is not a fitted model. */
export const selectRidgeTrainingCandidate = (
  cursor: HistoricalMarketCursor,
  query: IntradaySnapshotQuery,
  calendar: MarketCalendarObservation,
  candidateSymbol: string,
) =>
  Result.gen(function* () {
    const observation = yield* extractSixBarResearchObservation(cursor, {
      ...query,
      calendar,
      rangeStartAt: utcInstantFromEpochMillis(Date.parse(query.rangeEndAt) - 6 * 60_000),
      symbols: [candidateSymbol, sixBarResearchDefinition.benchmarkSymbol].sort(),
      candidateSymbols: [candidateSymbol],
      candidateEvidencePolicy: sixBarResearchDefinition.candidateEvidencePolicy,
      maximumQuoteAgeMs: sixBarResearchDefinition.maximumQuoteAgeMs,
      minimumWatermarkLagMs: sixBarResearchDefinition.minimumWatermarkLagMs,
    })
    if (observation.status !== SixBarResearchStatus.Available && !isCandidateExclusion(observation))
      return { status: 'UNAVAILABLE' as const, observations: [observation] }
    const feature =
      observation.status === SixBarResearchStatus.Available ? featureRowFromObservation(observation) : null
    const evidence = {
      schemaVersion: 'bayn.ridge-training-selection.v1',
      candidateSymbol,
      selectedSymbol: feature === null ? null : candidateSymbol,
      feature,
      observation,
      exclusions:
        observation.status === SixBarResearchStatus.Available
          ? []
          : [
              {
                symbol: candidateSymbol,
                inputSymbol: observation.symbol,
                reason: observation.reason,
                evidenceHash: observation.evidenceHash,
              },
            ],
    } as const
    return { status: 'AVAILABLE' as const, evidence, evidenceHash: yield* canonicalHashV1Result(evidence) }
  })

export type RidgeTrainingSelection = Result.Result.Success<ReturnType<typeof selectRidgeTrainingCandidate>>
export type RidgeTrainingFeature = ReturnType<typeof featureRowFromObservation>
export enum RidgeTrainingOutcome {
  Resolved = 'RESOLVED',
  NoEntryFill = 'NO_ENTRY_FILL',
  Unresolved = 'UNRESOLVED',
}
export interface RidgeTrainingAttempt {
  readonly features: RidgeTrainingFeature
  readonly decisionHash: string
  readonly selectionHash: string
  readonly openingCashMicros: string
  readonly openingTurnoverMicros: string
  readonly outcome: RidgeTrainingOutcome
  readonly reason: string
  readonly completeAt: string | null
  readonly netExecutionPnlMicros: string | null
  readonly orders: readonly unknown[]
}
