import type { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { databaseUtcInstant } from '../db/clock'
import { Sha256Schema, UtcDatabaseInstantSchema } from '../schemas'
import { SystemAssessmentError } from './economics'

const Admission = Schema.Struct({
  admittedAt: UtcDatabaseInstantSchema,
  firstOpenAt: UtcDatabaseInstantSchema,
})
export const PairedIncumbentWitnessSchema = Schema.Struct({
  ...Admission.fields,
  generationHash: Sha256Schema,
  authorityVersion: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
})

export const readPairedWitness = (
  sql: PgClient.PgClient,
  registrationHash: string,
  table: 'qualification_incumbent_witnesses' | 'qualification_pair_seals',
) =>
  sql`SELECT ${databaseUtcInstant(sql, sql`admitted_at`)} AS "admittedAt",
      ${databaseUtcInstant(sql, sql`first_open_at`)} AS "firstOpenAt",
      generation_hash AS "generationHash", authority_version::text AS "authorityVersion"
      FROM ${sql(table)} WHERE registration_hash = ${registrationHash}`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PairedIncumbentWitnessSchema))),
    Effect.map((rows) => rows[0]),
  )

export const requirePairedIncumbentWitness = (
  candidate: PgClient.PgClient,
  incumbent: PgClient.PgClient,
  registrationHash: string,
  generationHash: string,
) =>
  Effect.gen(function* () {
    const expected = yield* readPairedWitness(candidate, registrationHash, 'qualification_pair_seals')
    const actual = yield* readPairedWitness(incumbent, registrationHash, 'qualification_incumbent_witnesses')
    if (
      expected === undefined ||
      actual === undefined ||
      expected.generationHash !== generationHash ||
      actual.generationHash !== expected.generationHash ||
      actual.authorityVersion !== expected.authorityVersion ||
      actual.admittedAt !== expected.admittedAt ||
      actual.firstOpenAt !== expected.firstOpenAt
    )
      return yield* new SystemAssessmentError({
        message: 'Paired registration seal differs from the incumbent witness',
      })
    return actual
  })
