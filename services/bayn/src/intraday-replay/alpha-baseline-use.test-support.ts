import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import type { IntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import type { AlphaBaselineSource } from '../system-assessment/alpha-observation-witness'
import { ReplayAlphaObservationSchema } from './alpha-report'

/** Synthetic receipt for verifier tests; runtime captures its values from the real entry invocation. */
export const replayAlphaObservationFixture = (
  observation: { readonly contentHash: string; readonly payload: IntradayAlphaObservation },
  source: AlphaBaselineSource,
  admission: {
    readonly admissionObservedAt?: string
    readonly commandIssuedAt?: string
    readonly admissionExpiresAt?: string
  } = {},
) =>
  Schema.decodeUnknownSync(ReplayAlphaObservationSchema)({
    ...observation,
    baselineUse: {
      schemaVersion: 'bayn.replay-alpha-baseline-use.v1',
      observationHash: observation.contentHash,
      cycleId: observation.payload.cycleId,
      authorityGenerationHash: observation.payload.authorityGenerationHash,
      sessionDate: source.payload.trailingBaseline.sessionDate,
      windowEndAt: observation.payload.manifest['rangeEndAt'],
      commandIssuedAt: admission.commandIssuedAt ?? admission.admissionObservedAt ?? observation.payload.observedAt,
      admissionObservedAt: admission.admissionObservedAt ?? observation.payload.observedAt,
      admissionExpiresAt:
        admission.admissionExpiresAt ?? new Date(Date.parse(observation.payload.observedAt) + 60_000).toISOString(),
      sourceObservationHash: source.observationHash,
      sourceWitnessHash: source.witnessSourceHash,
      baselineHash: Result.getOrThrow(canonicalHashV1Result(source.payload.trailingBaseline)),
    },
  })
