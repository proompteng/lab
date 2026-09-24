import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { Sha256Schema, UtcInstantSchema } from '../schemas'
import { currentUtcInstant } from '../time'
import { OperationDeadlineClock } from '../operation-timeout'
import { ReplayBrokerFailure } from './broker'
import { makeReplayWorkClock } from './work-clock'

enum MeasurementState {
  Idle,
  Measuring,
  ReadingSource,
}

export const makeSimulatedExecutionClock = (runId: string, sourceManifestHash: string, providerClock: Clock.Clock) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(Sha256Schema)(runId)
    yield* Schema.decodeUnknownEffect(Sha256Schema)(sourceManifestHash)
    const sql = yield* PgClient.PgClient
    const accountId = `replay-${runId}`
    let state = MeasurementState.Idle
    const workClock = yield* makeReplayWorkClock(providerClock)
    const observedAt = yield* currentUtcInstant
    yield* sql`INSERT INTO simulated_execution_clocks (account_id, source_manifest_hash, observed_at)
    VALUES (${accountId}, ${sourceManifestHash}, ${observedAt}::timestamptz) ON CONFLICT(account_id) DO NOTHING`
    const advanceTo = (time: string) =>
      Schema.decodeUnknownEffect(UtcInstantSchema)(time).pipe(
        Effect.flatMap(
          (instant) =>
            sql<Record<string, unknown>>`UPDATE simulated_execution_clocks
      SET observed_at = ${instant}::timestamptz,
        measured_observed_at = CASE WHEN measured_at IS NULL THEN NULL
          ELSE greatest(${instant}::timestamptz, execution_account_commit_now(${accountId})) END,
        measured_at = CASE WHEN measured_at IS NULL THEN NULL ELSE clock_timestamp() END
      WHERE account_id = ${accountId} AND source_manifest_hash = ${sourceManifestHash}
        AND source_read_started_at IS NULL RETURNING account_id`,
        ),
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ account_id: Schema.Literal(accountId) })).check(Schema.isLengthBetween(1, 1)),
          ),
        ),
        Effect.asVoid,
      )
    yield* advanceTo(observedAt)
    const beginMeasurement = sql`UPDATE simulated_execution_clocks
      SET measured_at = clock_timestamp(), measured_observed_at = observed_at
      WHERE account_id = ${accountId} AND source_manifest_hash = ${sourceManifestHash} AND measured_at IS NULL
      RETURNING account_id`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ account_id: Schema.Literal(accountId) })])),
      ),
    )
    const endMeasurement = Effect.gen(function* () {
      const current = yield* currentUtcInstant
      const rows = yield* sql`UPDATE simulated_execution_clocks
        SET observed_at = to_timestamp(ceil(extract(epoch FROM greatest(
          ${current}::timestamptz, execution_account_commit_now(${accountId})
        )) * 1000) / 1000), measured_at = NULL, measured_observed_at = NULL
        WHERE account_id = ${accountId} AND source_manifest_hash = ${sourceManifestHash} AND measured_at IS NOT NULL
        RETURNING to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ observed_at: UtcInstantSchema })]))),
      )
      yield* TestClock.setTime(Math.max(yield* Clock.currentTimeMillis, Date.parse(rows[0].observed_at)))
    })
    const measurementFailure = (cause: unknown) =>
      new ReplayBrokerFailure({ message: 'Measured replay database clock failed', cause })
    const begin = beginMeasurement.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          state = MeasurementState.Measuring
        }),
      ),
      Effect.mapError(measurementFailure),
    )
    const pause = sql`UPDATE simulated_execution_clocks
      SET source_read_started_at = clock_timestamp()
      WHERE account_id = ${accountId} AND source_manifest_hash = ${sourceManifestHash}
        AND measured_at IS NOT NULL AND source_read_started_at IS NULL
      RETURNING account_id`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ account_id: Schema.Literal(accountId) })])),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          state = MeasurementState.ReadingSource
        }),
      ),
      Effect.mapError(measurementFailure),
    )
    const resume = sql`UPDATE simulated_execution_clocks
      SET measured_at = measured_at + greatest(interval '0 seconds', clock_timestamp() - source_read_started_at),
        source_read_started_at = NULL
      WHERE account_id = ${accountId} AND source_manifest_hash = ${sourceManifestHash}
        AND measured_at IS NOT NULL AND source_read_started_at IS NOT NULL
      RETURNING account_id`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ account_id: Schema.Literal(accountId) })])),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          state = MeasurementState.Measuring
        }),
      ),
      Effect.mapError(measurementFailure),
    )
    const excludeSourceTime = <A, E, R>(
      operation: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | ReplayBrokerFailure, R> =>
      Effect.suspend(() => {
        if (state === MeasurementState.Idle) return operation
        if (state !== MeasurementState.Measuring)
          return Effect.fail(new ReplayBrokerFailure({ message: 'Replay source measurements cannot overlap' }))
        return Effect.acquireUseRelease(
          pause,
          () => workClock.excludeSourceTime(operation),
          () => resume,
        )
      })
    const measure = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        begin,
        () => operation,
        () =>
          endMeasurement.pipe(
            Effect.mapError(measurementFailure),
            Effect.ensuring(
              Effect.sync(() => {
                state = MeasurementState.Idle
              }),
            ),
          ),
      ).pipe(Effect.provideService(OperationDeadlineClock, workClock.clock))
    return {
      accountId,
      sourceManifestHash,
      now: sql`execution_account_now(${accountId})`,
      advanceTo,
      measure,
      excludeSourceTime,
      excludedSourceMillis: workClock.excludedSourceMillis,
    }
  })

export type SimulatedExecutionClock = Effect.Success<ReturnType<typeof makeSimulatedExecutionClock>>
