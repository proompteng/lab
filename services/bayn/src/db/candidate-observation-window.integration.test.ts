import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Option, Redacted } from 'effect'

import observationWindowIndex from '../../migrations/0163_jev_observation_window_index'
import { JevPurpose } from '../jev/portfolio'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { makeCandidateObservationStore } from './candidate-observation-postgres'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const runtime = ManagedRuntime.make(
  PostgresClientLive({
    operationTimeoutMs: 10_000,
    postgres: {
      url: Redacted.make(baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'),
      tls: false,
      caPath: '/unused',
    },
  }).pipe(Layer.provideMerge(NodeServices.layer)),
)

describePostgres('PostgreSQL consumed Jev window lookup', () => {
  beforeAll(() => runtime.runPromise(postgresMigrations))
  afterAll(() => runtime.dispose())

  test('indexes the exact maximum window without rewriting retained payloads or mixing scopes', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`CREATE TEMP TABLE intraday_candidate_observations (
              content_hash text, cycle_id text, observed_at timestamptz, payload jsonb
            ) ON COMMIT DROP`
            yield* sql`CREATE INDEX probe_cycle_time ON intraday_candidate_observations(cycle_id, observed_at)`
            const cycleId = '1'.repeat(64)
            const otherCycleId = '2'.repeat(64)
            const rows = [
              [cycleId, JevPurpose.Entry, '2026-09-04T14:30:00.000Z', '2026-09-04T14:31:00.000Z'],
              [cycleId, JevPurpose.Entry, '2026-09-04T14:29:00.000Z', '2026-09-04T14:35:00.000Z'],
              [cycleId, JevPurpose.Manage, '2026-09-04T15:00:00.000Z', '2026-09-04T15:01:00.000Z'],
              [otherCycleId, JevPurpose.Entry, '2026-09-04T16:00:00.000Z', '2026-09-04T16:01:00.000Z'],
            ] as const
            for (const [index, [scope, purpose, windowEndAt, observedAt]] of rows.entries()) {
              yield* sql`INSERT INTO intraday_candidate_observations
                VALUES (${String(index)}, ${scope}, ${observedAt}, ${sql.json({
                  schemaVersion: 'bayn.jev-observation.v1',
                  portfolio: { purpose },
                  manifest: { rangeEndAt: windowEndAt },
                  sourcePadding: 'retained immutable source '.repeat(10_000),
                })})`
            }
            yield* sql`INSERT INTO intraday_candidate_observations VALUES ('retired',${cycleId},
              '2026-09-04T17:01:00Z',${sql.json({
                schemaVersion: 'bayn.intraday-candidate-observation.v2',
                portfolio: { purpose: JevPurpose.Entry },
                manifest: { rangeEndAt: '2026-09-04T17:00:00.000Z' },
              })})`
            const store = yield* makeCandidateObservationStore
            const readWindows = Effect.all([
              store.latestJevWindowEnd({ cycleId, purpose: JevPurpose.Entry }),
              store.latestJevWindowEnd({ cycleId, purpose: JevPurpose.Manage }),
              store.latestJevWindowEnd({ cycleId: otherCycleId, purpose: JevPurpose.Entry }),
              store.latestJevWindowEnd({ cycleId: '3'.repeat(64), purpose: JevPurpose.Entry }),
            ])
            const expected = [
              Option.some('2026-09-04T14:30:00.000Z'),
              Option.some('2026-09-04T15:00:00.000Z'),
              Option.some('2026-09-04T16:00:00.000Z'),
              Option.none(),
            ]
            expect([...(yield* readWindows)]).toEqual(expected)
            const original = yield* sql`SELECT * FROM intraday_candidate_observations ORDER BY content_hash`
            yield* observationWindowIndex
            expect([...(yield* readWindows)]).toEqual(expected)
            expect(yield* sql`SELECT * FROM intraday_candidate_observations ORDER BY content_hash`).toEqual(original)
            yield* sql`ANALYZE intraday_candidate_observations`
            yield* sql`SET LOCAL enable_seqscan=off`
            const plan = yield* sql`EXPLAIN (ANALYZE,FORMAT JSON)
              SELECT max(payload #>> '{manifest,rangeEndAt}') FROM intraday_candidate_observations
              WHERE cycle_id=${cycleId} AND payload->>'schemaVersion'='bayn.jev-observation.v1'
                AND payload #>> '{portfolio,purpose}'=${JevPurpose.Entry}`
            const actual = JSON.stringify(plan)
            expect(actual).toContain('intraday_candidate_observations_jev_window')
            expect(actual).toContain('"Node Type":"Limit"')
            expect(actual).toContain('"Scan Direction":"Backward"')
          }),
        )
      }),
    )
  })
})
