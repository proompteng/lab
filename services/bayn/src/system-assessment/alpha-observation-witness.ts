import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import {
  IntradayAlphaObservationSchema,
  reproduceIntradayAlphaObservation,
} from '../strategy/intraday-alpha/observation'
import { SystemAssessmentError } from './economics'
import type { AlphaObservationEvidenceSchema, SystemSourceCut } from './source-cut'

export const AlphaObservationWitnessSchema = Schema.Struct({
  registrationHash: Sha256Schema,
  kind: Schema.Literal('ALPHA_OBSERVATION'),
  sourceHash: Sha256Schema,
  sourceAt: UtcInstantSchema,
  witnessedAt: UtcInstantSchema,
  correct: Schema.Boolean,
})
export type AlphaObservationWitness = typeof AlphaObservationWitnessSchema.Type

export const AlphaBaselineSourceSchema = Schema.Struct({
  observationHash: Sha256Schema,
  payload: IntradayAlphaObservationSchema,
  availableAt: UtcInstantSchema,
  witnessSourceHash: Sha256Schema,
})
export type AlphaBaselineSource = typeof AlphaBaselineSourceSchema.Type

type ObservationSource = typeof AlphaObservationEvidenceSchema.Type
type DurableObservation = SystemSourceCut['durableObservations'][number]

const invalid = (message: string, cause?: unknown) =>
  Result.fail(new SystemAssessmentError({ message, ...(cause === undefined ? {} : { cause }) }))

const authenticateObservation = (source: ObservationSource, asOf: string) =>
  Result.gen(function* () {
    const reproduced = yield* reproduceIntradayAlphaObservation(source.payload).pipe(
      Result.mapError(
        (cause) => new SystemAssessmentError({ message: 'Retained alpha observation did not reproduce', cause }),
      ),
    )
    if (reproduced.contentHash !== source.contentHash || Date.parse(source.payload.observedAt) > Date.parse(asOf))
      return yield* invalid('Retained alpha observation hash or source cutoff differs')
    return source
  })

const selectWitness = (
  cut: Pick<SystemSourceCut, 'registrationHash' | 'asOf'>,
  source: ObservationSource,
  observations: readonly DurableObservation[],
): Result.Result<AlphaObservationWitness | null, SystemAssessmentError> =>
  Result.gen(function* () {
    let first: AlphaObservationWitness | null = null
    for (const observation of observations) {
      if (observation.kind !== 'ALPHA_OBSERVATION' || observation.sourceHash !== source.contentHash) continue
      const witness = yield* Schema.decodeUnknownResult(
        AlphaObservationWitnessSchema,
        strictParseOptions,
      )({ registrationHash: cut.registrationHash, ...observation }).pipe(
        Result.mapError(
          (cause) => new SystemAssessmentError({ message: 'Alpha observation witness is malformed', cause }),
        ),
      )
      if (
        witness.sourceAt !== source.payload.observedAt ||
        Date.parse(witness.witnessedAt) < Date.parse(witness.sourceAt) ||
        Date.parse(witness.witnessedAt) > Date.parse(cut.asOf)
      )
        return yield* invalid('Alpha observation witness differs from its source time or immutable cutoff')
      if (witness.correct && (first === null || witness.witnessedAt < first.witnessedAt)) first = witness
    }
    return first
  })

/** A payload timestamp is not availability. Only the later committed controller witness supplies it. */
export const earliestAlphaObservationWitness = (
  cut: SystemSourceCut,
  observationHash: string,
): Result.Result<AlphaObservationWitness | null, SystemAssessmentError> =>
  Result.gen(function* () {
    if (cut.schemaVersion === 'bayn.system-source-cut.v4') return null
    const sources = cut.alphaObservations.filter((source) => source.contentHash === observationHash)
    if (sources.length > 1) return yield* invalid('Source cut repeats an alpha observation identity')
    const source = sources[0]
    if (source === undefined) {
      if (cut.durableObservations.some((row) => row.kind === 'ALPHA_OBSERVATION' && row.sourceHash === observationHash))
        return yield* invalid('Alpha observation witness has no retained payload')
      return null
    }
    yield* authenticateObservation(source, cut.asOf)
    return yield* selectWitness(cut, source, cut.durableObservations)
  })

export const deriveAlphaBaselineSources = (
  cut: SystemSourceCut,
): Result.Result<readonly AlphaBaselineSource[], SystemAssessmentError> =>
  Result.gen(function* () {
    if (cut.schemaVersion !== 'bayn.system-source-cut.v5') return []
    const witnesses = new Map<string, DurableObservation[]>()
    for (const witness of cut.durableObservations) {
      if (witness.kind !== 'ALPHA_OBSERVATION') continue
      const existing = witnesses.get(witness.sourceHash)
      if (existing === undefined) witnesses.set(witness.sourceHash, [witness])
      else existing.push(witness)
    }
    const seen = new Set<string>()
    const sources: AlphaBaselineSource[] = []
    for (const source of cut.alphaObservations) {
      if (seen.has(source.contentHash)) return yield* invalid('Source cut repeats an alpha observation identity')
      seen.add(source.contentHash)
      yield* authenticateObservation(source, cut.asOf)
      const witness = yield* selectWitness(cut, source, witnesses.get(source.contentHash) ?? [])
      if (witness === null) continue
      sources.push({
        observationHash: source.contentHash,
        payload: source.payload,
        availableAt: witness.witnessedAt,
        witnessSourceHash: yield* canonicalHashV1Result(witness).pipe(
          Result.mapError((cause) => new SystemAssessmentError({ message: 'Alpha witness hash failed', cause })),
        ),
      })
    }
    if ([...witnesses.keys()].some((hash) => !seen.has(hash)))
      return yield* invalid('Alpha observation witness has no retained payload')
    return sources.toSorted(
      (a, b) => a.availableAt.localeCompare(b.availableAt) || a.observationHash.localeCompare(b.observationHash),
    )
  })
