import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { preparedAlphaBaselineFixture } from '../observe-composition/alpha-baseline-preparation.test-support'
import type { IntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import {
  derivePreparedAlphaBaselineSources,
  type PreparedAlphaBaselineSource,
} from '../system-assessment/alpha-baseline-witness'
import { makeResearchStrategyBinding, ResearchStrategyEngine } from '../system-assessment/strategy-binding'
import { PreparedReplayAlphaObservationSchema } from './alpha-report'

/** Synthetic, unqualified preparation and witness; never an operational source acquisition. */
export const preparedReplayAlphaBaselineFixture = (availableAt = '2026-09-04T12:01:04.000Z') => {
  const record = preparedAlphaBaselineFixture()
  const binding = Result.getOrThrow(
    makeResearchStrategyBinding({
      engine: ResearchStrategyEngine.IntradayAlpha,
      parameters: record.payload.policy,
    }),
  )
  const sources = Result.getOrThrow(
    derivePreparedAlphaBaselineSources({
      registrationHash: 'f'.repeat(64),
      asOf: availableAt,
      alphaBaselinePreparations: [record],
      durableObservations: [
        {
          kind: 'ALPHA_BASELINE',
          sourceHash: record.contentHash,
          sourceAt: record.recordedAt,
          witnessedAt: availableAt,
          correct: true,
        },
      ],
    }),
  )
  const source = sources[0]
  if (source === undefined) throw new Error('Missing synthetic prepared baseline witness')
  return { binding, source, record }
}

/** Runtime captures this receipt only after the observation's durable write; this helper is for verifier fixtures. */
export const preparedReplayAlphaObservationFixture = (
  observation: { readonly contentHash: string; readonly payload: IntradayAlphaObservation },
  source: PreparedAlphaBaselineSource,
  admission: {
    readonly admissionObservedAt?: string
    readonly commandIssuedAt?: string
    readonly admissionExpiresAt?: string
  } = {},
) =>
  Schema.decodeUnknownSync(PreparedReplayAlphaObservationSchema)({
    ...observation,
    baselineUse: {
      schemaVersion: 'bayn.replay-alpha-baseline-use.v2',
      observationHash: observation.contentHash,
      cycleId: observation.payload.cycleId,
      authorityGenerationHash: observation.payload.authorityGenerationHash,
      sessionDate: source.payload.sessionDate,
      windowEndAt: observation.payload.manifest['rangeEndAt'],
      commandIssuedAt: admission.commandIssuedAt ?? admission.admissionObservedAt ?? observation.payload.observedAt,
      admissionObservedAt: admission.admissionObservedAt ?? observation.payload.observedAt,
      admissionExpiresAt:
        admission.admissionExpiresAt ?? new Date(Date.parse(observation.payload.observedAt) + 60_000).toISOString(),
      sourcePreparationHash: source.preparationHash,
      sourceWitnessHash: source.witnessSourceHash,
      baselineHash: Result.getOrThrow(canonicalHashV1Result(source.payload.acquisition.trailingBaseline)),
    },
  })
