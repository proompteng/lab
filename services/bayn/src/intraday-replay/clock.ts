import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'
import { Sha256Schema, UtcInstantSchema } from '../schemas'
import { currentUtcInstant } from '../time'

export const makeSimulatedExecutionClock = (runId: string, sourceManifestHash: string) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(Sha256Schema)(runId)
    yield* Schema.decodeUnknownEffect(Sha256Schema)(sourceManifestHash)
    const sql = yield* PgClient.PgClient
    const accountId = `replay-${runId}`
    const observedAt = yield* currentUtcInstant
    yield* sql`INSERT INTO simulated_execution_clocks (account_id, source_manifest_hash, observed_at)
    VALUES (${accountId}, ${sourceManifestHash}, ${observedAt}::timestamptz) ON CONFLICT(account_id) DO NOTHING`
    const advanceTo = (time: string) =>
      Schema.decodeUnknownEffect(UtcInstantSchema)(time).pipe(
        Effect.flatMap(
          (instant) =>
            sql<Record<string, unknown>>`UPDATE simulated_execution_clocks SET observed_at = ${instant}::timestamptz
      WHERE account_id = ${accountId} AND source_manifest_hash = ${sourceManifestHash} RETURNING account_id`,
        ),
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ account_id: Schema.Literal(accountId) })).check(Schema.isLengthBetween(1, 1)),
          ),
        ),
        Effect.asVoid,
      )
    yield* advanceTo(observedAt)
    return { accountId, sourceManifestHash, now: sql`execution_account_now(${accountId})`, advanceTo }
  })

export type SimulatedExecutionClock = Effect.Success<ReturnType<typeof makeSimulatedExecutionClock>>
