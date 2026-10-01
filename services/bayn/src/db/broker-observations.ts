import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Result, Schema } from 'effect'

import {
  BrokerObservations,
  decodeObservedBrokerSnapshot,
  observedBrokerSnapshotHash,
  observationUnavailable,
  validateObservedBrokerSnapshot,
  type BrokerObservationTicket,
  type ObservedBrokerSnapshot,
} from '../broker/alpaca/observed-snapshot'
import { BrokerReadError } from '../broker/alpaca/failures'
import { mutationConsistencyDelayMs } from '../broker/alpaca/model'
import { currentUtcInstant } from '../time'
import { UtcInstantSchema, strictParseOptions } from '../schemas'

export const makeBrokerObservationStore = (
  sql: PgClient.PgClient,
  accountId: string,
  sourceRevision: string,
  maximumAgeMs: number,
) => {
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, BrokerReadError, R> =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof BrokerReadError
          ? cause
          : observationUnavailable('Broker observation persistence failed', cause),
      ),
    )
  const activate = run(
    sql`
    INSERT INTO broker_observations (account_id, source_revision)
    VALUES (${accountId}, ${sourceRevision})
    ON CONFLICT (account_id) DO UPDATE SET source_revision = EXCLUDED.source_revision,
      generation = broker_observations.generation + 1, available = false
  `.pipe(Effect.asVoid),
  )
  const invalidate = run(
    sql`
    UPDATE broker_observations SET generation = generation + 1, available = false
    WHERE account_id = ${accountId}
  `.pipe(Effect.asVoid),
  )
  const begin = run(
    sql`
    UPDATE broker_observations SET generation = generation + 1
    WHERE account_id = ${accountId} AND source_revision = ${sourceRevision}
    RETURNING generation,
      to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt"
  `.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              generation: Schema.Int.check(Schema.isGreaterThan(0)),
              startedAt: UtcInstantSchema,
            }),
          ).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
          strictParseOptions,
        ),
      ),
      Effect.map((rows) => rows[0]),
      Effect.flatMap((ticket) =>
        ticket === undefined
          ? Effect.fail(observationUnavailable('Broker observation owner is unavailable'))
          : Effect.succeed(ticket),
      ),
    ),
  )
  const publish = (ticket: BrokerObservationTicket, value: ObservedBrokerSnapshot) =>
    run(
      Effect.gen(function* () {
        yield* validateObservedBrokerSnapshot(value, accountId, yield* currentUtcInstant, maximumAgeMs)
        if (value.startedAt !== ticket.startedAt)
          return yield* observationUnavailable('Broker poll start does not match its durable ticket')
        const rows = yield* sql`
      UPDATE broker_observations SET available = true, poll_started_at = ${value.startedAt}::timestamptz,
        observed_at = ${value.observedAt}::timestamptz, completed_at = ${value.completedAt}::timestamptz,
        snapshot_hash = ${observedBrokerSnapshotHash(value)}, payload = ${sql.json(value)}
      WHERE account_id = ${accountId} AND source_revision = ${sourceRevision} AND generation = ${ticket.generation}
        AND (poll_started_at IS NULL OR poll_started_at <= ${ticket.startedAt}::timestamptz)
        AND NOT EXISTS (
          SELECT 1 FROM mutation_events AS mutation JOIN intents AS intent USING (intent_id)
          WHERE intent.account_id = ${accountId}
            AND mutation.occurred_at + ${mutationConsistencyDelayMs} * interval '1 millisecond' >= ${ticket.startedAt}::timestamptz
        )
        AND NOT EXISTS (SELECT 1 FROM broker_events WHERE account_id = ${accountId}
          AND observed_at > ${ticket.startedAt}::timestamptz)
      RETURNING account_id
    `
        return rows.length === 1
      }),
    )
  const failed = (ticket: BrokerObservationTicket) =>
    run(
      sql`
    UPDATE broker_observations SET available = false, poll_started_at = ${ticket.startedAt}::timestamptz
    WHERE account_id = ${accountId} AND source_revision = ${sourceRevision} AND generation = ${ticket.generation}
      AND (poll_started_at IS NULL OR poll_started_at <= ${ticket.startedAt}::timestamptz)
  `.pipe(Effect.asVoid),
    )
  const readProjection = (intentId: string | null) =>
    run(
      Effect.gen(function* () {
        const rows = yield* sql`
      SELECT payload, snapshot_hash FROM broker_observations
      WHERE account_id = ${accountId} AND source_revision = ${sourceRevision} AND available
        AND NOT EXISTS (
          SELECT 1 FROM mutation_events AS mutation JOIN intents AS intent USING (intent_id)
          WHERE intent.account_id = ${accountId} AND mutation.occurred_at >= poll_started_at
            AND NOT (${intentId}::text IS NOT NULL AND mutation.intent_id = ${intentId}
              AND mutation.event_type = 'SUBMIT_STARTED')
        )
        AND NOT EXISTS (SELECT 1 FROM broker_events WHERE account_id = ${accountId}
          AND observed_at > completed_at)
        AND (${intentId}::text IS NULL OR NOT EXISTS (
          SELECT 1 FROM (
            SELECT DISTINCT ON (mutation.mutation_id) mutation.intent_id, mutation.event_type, mutation.operation, intent.state
            FROM mutation_events AS mutation JOIN intents AS intent USING (intent_id)
            WHERE intent.account_id = ${accountId}
            ORDER BY mutation.mutation_id, mutation.sequence DESC
          ) AS latest WHERE latest.state <> 'TERMINAL' AND (
            latest.event_type IN ('SUBMIT_STARTED', 'SUBMIT_UNKNOWN', 'RECOVERY_NOT_FOUND', 'RECOVERY_UNKNOWN',
              'CANCEL_STARTED', 'CANCEL_ACCEPTED', 'CANCEL_UNKNOWN')
            OR (latest.operation = 'CANCEL' AND latest.event_type = 'RECOVERY_FOUND')
          ) AND NOT (latest.intent_id = ${intentId} AND latest.event_type = 'SUBMIT_STARTED')
        ))
        AND (${intentId}::text IS NULL OR EXISTS (
          SELECT 1 FROM intents AS reserved
          WHERE reserved.intent_id = ${intentId} AND reserved.account_id = ${accountId} AND reserved.state = 'IO_STARTED'
            AND EXISTS (SELECT 1 FROM mutation_events WHERE intent_id = reserved.intent_id
              AND event_type = 'SUBMIT_STARTED')
        ))
    `.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Array(
                Schema.Struct({
                  payload: Schema.Unknown,
                  snapshot_hash: Schema.String,
                }),
              ),
              strictParseOptions,
            ),
          ),
        )
        const row = rows[0]
        if (row === undefined)
          return yield* observationUnavailable('Broker observation is unavailable or invalidated by a mutation')
        const decoded = decodeObservedBrokerSnapshot(row.payload)
        if (Result.isFailure(decoded))
          return yield* observationUnavailable('Persisted broker observation failed decoding', decoded.failure)
        if (observedBrokerSnapshotHash(decoded.success) !== row.snapshot_hash)
          return yield* observationUnavailable('Persisted broker observation content hash changed')
        return yield* validateObservedBrokerSnapshot(decoded.success, accountId, yield* currentUtcInstant, maximumAgeMs)
      }),
    )
  return { activate, begin, publish, failed, invalidate, read: readProjection(null), readForSubmit: readProjection }
}

export const BrokerObservationsLive = (accountId: string, sourceRevision: string, maximumAgeMs: number) =>
  Layer.effect(
    BrokerObservations,
    Effect.map(PgClient.PgClient, (sql) => makeBrokerObservationStore(sql, accountId, sourceRevision, maximumAgeMs)),
  )
