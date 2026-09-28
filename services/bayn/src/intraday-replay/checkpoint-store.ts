import { PgClient } from '@effect/sql-pg'
import { Context, Effect, Layer, Schema } from 'effect'
import { PostgresClientLive } from '../db/postgres-client'
import type { RuntimeConfig } from '../config'
import { Sha256Schema, strictParseOptions } from '../schemas'
import { canonicalHashV1Result } from '../hash'
import { ReplayBrokerCheckpointSchema, ReplayCheckpointFailure } from './broker-checkpoint'

/** Checkpoint bytes and their receipt commit together outside the interrupted execution transaction. */
const retainReplayCheckpoint = (input: unknown) =>
  Effect.gen(function* () {
    const checkpoint = yield* Schema.decodeUnknownEffect(ReplayBrokerCheckpointSchema, strictParseOptions)(input)
    const { checkpointHash, ...material } = checkpoint
    if ((yield* Effect.fromResult(canonicalHashV1Result(material))) !== checkpointHash)
      return yield* new ReplayCheckpointFailure({ message: 'Cannot retain a checkpoint with a different content hash' })
    const sql = yield* PgClient.PgClient
    yield* sql`INSERT INTO simulated_broker_checkpoints(account_id, source_manifest_hash, checkpoint_hash, observed_at, payload)
    VALUES(${checkpoint.state.accountId}, ${checkpoint.sourceManifestHash}, ${checkpointHash}, ${checkpoint.observedAt}::timestamptz, ${sql.json(checkpoint)})
    ON CONFLICT(account_id, checkpoint_hash) DO NOTHING`
  })

/** Recover from the independently committed broker state; external export files are not needed. */
const loadReplayCheckpoint = (runId: string, sourceManifestHash: string) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(Sha256Schema)(runId)
    yield* Schema.decodeUnknownEffect(Sha256Schema)(sourceManifestHash)
    const sql = yield* PgClient.PgClient
    // The broker commit can be ahead of SQL time when SIGKILL rolls back the coordinator transaction.
    const rows = yield* sql`SELECT checkpoint_hash, payload FROM simulated_broker_checkpoints checkpoint
    JOIN simulated_execution_clocks clock USING(account_id)
    WHERE checkpoint.account_id = ${`replay-${runId}`} AND checkpoint.source_manifest_hash = ${sourceManifestHash}
      AND clock.source_manifest_hash = checkpoint.source_manifest_hash AND clock.observed_at <= checkpoint.observed_at
    ORDER BY ordinal DESC LIMIT 1`
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ checkpoint_hash: Sha256Schema, payload: ReplayBrokerCheckpointSchema })).check(
        Schema.isLengthBetween(1, 1),
      ),
    )(rows)
    const row = decoded[0]
    if (row === undefined)
      return yield* new ReplayCheckpointFailure({ message: 'Replay has no durable broker checkpoint' })
    const { checkpointHash, ...material } = row.payload
    if (
      checkpointHash !== row.checkpoint_hash ||
      (yield* Effect.fromResult(canonicalHashV1Result(material))) !== row.checkpoint_hash
    )
      return yield* new ReplayCheckpointFailure({ message: 'Durable checkpoint payload differs from its receipt' })
    return { value: row.payload, expectedHash: row.checkpoint_hash }
  })

/** A separate scoped pool keeps broker commits outside interrupted coordinator transactions. */
export const makeReplayCheckpointStore = (config: Pick<RuntimeConfig, 'postgres' | 'operationTimeoutMs'>) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(PostgresClientLive(config))
    const sql = Context.get(context, PgClient.PgClient)
    return {
      retain: (input: unknown) => retainReplayCheckpoint(input).pipe(Effect.provideService(PgClient.PgClient, sql)),
      load: (runId: string, sourceManifestHash: string) =>
        loadReplayCheckpoint(runId, sourceManifestHash).pipe(Effect.provideService(PgClient.PgClient, sql)),
    }
  })
