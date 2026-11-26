import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import {
  AlphaBaselinePreparationSchema,
  reproduceRecordedAlphaBaselinePreparation,
  type RecordedAlphaBaselinePreparation,
} from '../observe-composition/alpha-baseline-preparation'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { SystemAssessmentError } from './economics'

export const PreparedAlphaBaselineSourceSchema = Schema.Struct({
  preparationHash: Sha256Schema,
  payload: AlphaBaselinePreparationSchema,
  recordedAt: UtcInstantSchema,
  availableAt: UtcInstantSchema,
  witnessSourceHash: Sha256Schema,
})
export type PreparedAlphaBaselineSource = typeof PreparedAlphaBaselineSourceSchema.Type
export const AlphaBaselineWitnessSchema = Schema.Struct({
  registrationHash: Sha256Schema,
  kind: Schema.Literal('ALPHA_BASELINE'),
  sourceHash: Sha256Schema,
  sourceAt: UtcInstantSchema,
  witnessedAt: UtcInstantSchema,
  correct: Schema.Boolean,
})

interface PreparedAlphaBaselineCut {
  readonly registrationHash: string
  readonly asOf: string
  readonly alphaBaselinePreparations: readonly RecordedAlphaBaselinePreparation[]
  readonly durableObservations: readonly {
    readonly kind: string
    readonly sourceHash: string
    readonly sourceAt: string
    readonly witnessedAt: string
    readonly correct: boolean
  }[]
}

/** No registration admission or later identical insertion can manufacture an earlier availability. */
export const derivePreparedAlphaBaselineSources = (cut: PreparedAlphaBaselineCut) =>
  Result.gen(function* () {
    const sources: PreparedAlphaBaselineSource[] = []
    const seen = new Set<string>()
    const witnesses = new Map<string, (typeof cut.durableObservations)[number][]>()
    for (const witness of cut.durableObservations) {
      if (witness.kind !== 'ALPHA_BASELINE') continue
      const rows = witnesses.get(witness.sourceHash) ?? []
      rows.push(witness)
      witnesses.set(witness.sourceHash, rows)
    }
    for (const raw of cut.alphaBaselinePreparations) {
      const record = yield* reproduceRecordedAlphaBaselinePreparation(raw)
      if (seen.has(record.contentHash) || record.recordedAt > cut.asOf)
        return yield* Result.fail(
          new SystemAssessmentError({ message: 'Prepared baseline source repeats or exceeds its immutable cutoff' }),
        )
      seen.add(record.contentHash)
      let first: typeof AlphaBaselineWitnessSchema.Type | undefined
      for (const witness of witnesses.get(record.contentHash) ?? []) {
        const verified = yield* Schema.decodeUnknownResult(
          AlphaBaselineWitnessSchema,
          strictParseOptions,
        )({ registrationHash: cut.registrationHash, ...witness })
        if (
          verified.sourceAt !== record.recordedAt ||
          verified.witnessedAt < record.recordedAt ||
          verified.witnessedAt > cut.asOf
        )
          return yield* Result.fail(
            new SystemAssessmentError({
              message: 'Prepared baseline witness differs from its actual server source time or cutoff',
            }),
          )
        if (verified.correct && (first === undefined || verified.witnessedAt < first.witnessedAt)) first = verified
      }
      if (first !== undefined)
        sources.push({
          preparationHash: record.contentHash,
          payload: record.payload,
          recordedAt: record.recordedAt,
          availableAt: first.witnessedAt,
          witnessSourceHash: yield* canonicalHashV1Result(first),
        })
    }
    if ([...witnesses.keys()].some((hash) => !seen.has(hash)))
      return yield* Result.fail(
        new SystemAssessmentError({ message: 'Prepared baseline witness has no retained source payload' }),
      )
    return sources.toSorted(
      (a, b) => a.availableAt.localeCompare(b.availableAt) || a.preparationHash.localeCompare(b.preparationHash),
    )
  }).pipe(
    Result.mapError(
      (cause) => new SystemAssessmentError({ message: 'Prepared alpha baseline evidence is invalid', cause }),
    ),
  )
