import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Schema } from 'effect'

import { operationalError } from '../errors'
import { CandidateObservationStore, type CandidateObservation } from '../observe-composition/candidate-observation'
import { Sha256Schema, strictParseOptions } from '../schemas'

export const makeCandidateObservationStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  return {
    record: ({ contentHash, payload }: CandidateObservation) =>
      Effect.gen(function* () {
        const inserted = yield* sql`
          INSERT INTO intraday_candidate_observations (content_hash, cycle_id, observed_at, payload)
          VALUES (${contentHash}, ${payload.cycleId}, ${payload.observedAt}::timestamptz, ${sql.json(payload)})
          ON CONFLICT (content_hash) DO NOTHING
          RETURNING content_hash
        `
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ content_hash: Sha256Schema })),
          strictParseOptions,
        )(inserted)
        if (rows.length === 1 && rows[0]?.content_hash === contentHash) return
        const existing = yield* sql`
          SELECT payload = ${sql.json(payload)} AS matches
          FROM intraday_candidate_observations WHERE content_hash = ${contentHash}
        `
        yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })]),
          strictParseOptions,
        )(existing)
      }).pipe(
        Effect.mapError((cause) =>
          operationalError({
            component: 'database',
            operation: 'candidate-observation',
            message: 'candidate observation was not durably recorded',
            cause,
          }),
        ),
      ),
  }
})

export const CandidateObservationStoreLive = Layer.effect(CandidateObservationStore, makeCandidateObservationStore)
