import { PgClient } from '@effect/sql-pg'
import { Effect, Option, Schema } from 'effect'

import { databaseUtcInstant } from '../db/clock'
import { JevResearchPolicy } from '../jev/acceptance'
import { UtcDatabaseInstantSchema } from '../schemas'
import { readRegisteredFinancialIdentity } from './capital-identity'
import { SystemAssessmentError } from './economics'
import { validateProspectiveSystemRegistration } from './policy'
import { registerSystemQualification } from './postgres'
import { readPairedWitness, requirePairedIncumbentWitness } from './paired-witness'

const Admission = Schema.Struct({
  admittedAt: UtcDatabaseInstantSchema,
  firstOpenAt: UtcDatabaseInstantSchema,
})
const readAdmission = (sql: PgClient.PgClient, registrationHash: string) =>
  sql`SELECT ${databaseUtcInstant(sql, sql`created_at`)} AS "admittedAt",
      ${databaseUtcInstant(sql, sql`first_open_at`)} AS "firstOpenAt"
      FROM system_qualification_registrations WHERE registration_hash = ${registrationHash}`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Admission))),
    Effect.map((rows) => rows[0]),
  )

export const registerPairedSystemQualification = (
  input: unknown,
  verifiedSources: ReadonlySet<string>,
  incumbentStore: PgClient.PgClient,
) =>
  Effect.gen(function* () {
    const { registration, registrationHash } = yield* Effect.fromResult(validateProspectiveSystemRegistration(input))
    const incumbent = registration.policies.find((policy) => policy.policy === JevResearchPolicy.Incumbent)
    const candidateStore = yield* PgClient.PgClient
    if (incumbent === undefined || incumbentStore === candidateStore)
      return yield* new SystemAssessmentError({
        message: 'Paired qualification requires the independent incumbent store',
      })
    if (
      Option.isSome(yield* Effect.serviceOption(candidateStore.transactionService)) ||
      Option.isSome(yield* Effect.serviceOption(incumbentStore.transactionService))
    )
      return yield* new SystemAssessmentError({ message: 'Paired qualification must own both admission transactions' })
    const localIncumbent = yield* candidateStore`SELECT 1 FROM authority_generations
      WHERE generation_hash = ${incumbent.authorityGenerationHash}`
    if (localIncumbent.length !== 0)
      return yield* new SystemAssessmentError({ message: 'Incumbent authority must belong to a separate store' })

    if ((yield* readAdmission(candidateStore, registrationHash)) === undefined) {
      yield* incumbentStore.withTransaction(
        Effect.gen(function* () {
          const identity = yield* readRegisteredFinancialIdentity(incumbent, { lockServingIncumbent: true }).pipe(
            Effect.provideService(PgClient.PgClient, incumbentStore),
          )
          if (identity === null)
            return yield* new SystemAssessmentError({ message: 'Independent incumbent authority is unavailable' })
          const admitted = yield* candidateStore.withTransaction(
            Effect.gen(function* () {
              yield* candidateStore`SELECT program FROM system_qualification_origin
                WHERE program = ${registration.program} FOR UPDATE`
              if ((yield* readAdmission(candidateStore, registrationHash)) !== undefined) return
              yield* registerSystemQualification(registration, verifiedSources)
              return yield* readAdmission(candidateStore, registrationHash)
            }),
          )
          // A retry cannot manufacture a peer witness for a previously committed attempt.
          if (admitted === undefined) return
          yield* incumbentStore`INSERT INTO qualification_incumbent_witnesses
            (registration_hash, admitted_at, first_open_at, generation_hash)
            VALUES (${registrationHash}, ${admitted.admittedAt}, ${admitted.firstOpenAt}, ${incumbent.authorityGenerationHash})`
        }),
      )
    }
    const witness = yield* readPairedWitness(incumbentStore, registrationHash, 'qualification_incumbent_witnesses')
    const admitted = yield* readAdmission(candidateStore, registrationHash)
    if (
      witness === undefined ||
      admitted === undefined ||
      witness.admittedAt !== admitted.admittedAt ||
      witness.firstOpenAt !== admitted.firstOpenAt ||
      witness.generationHash !== incumbent.authorityGenerationHash
    )
      return yield* new SystemAssessmentError({
        message: 'Paired registration has no exact committed incumbent witness',
      })

    const sealed = yield* readPairedWitness(candidateStore, registrationHash, 'qualification_pair_seals')
    if (sealed === undefined) {
      yield* candidateStore`INSERT INTO qualification_pair_seals
        (registration_hash, admitted_at, first_open_at, generation_hash, authority_version)
        VALUES (${registrationHash}, ${witness.admittedAt}, ${witness.firstOpenAt}, ${witness.generationHash},
          ${witness.authorityVersion}::bigint)
        ON CONFLICT DO NOTHING`
    }
    yield* requirePairedIncumbentWitness(
      candidateStore,
      incumbentStore,
      registrationHash,
      incumbent.authorityGenerationHash,
    )
    return { registrationHash, registration }
  })
