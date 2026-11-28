import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, ManagedRuntime, Redacted, Schema } from 'effect'
import { SqlClient } from 'effect/sql'

import riskValuationIndexes from '../../migrations/0117_risk_valuation_indexes'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { firstSessionEquityQuery, peakEquityQuery } from './risk-valuation-query'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const Plan = Schema.Struct({
  'Shared Hit Blocks': Schema.Number,
  'Shared Read Blocks': Schema.Number,
  'Local Hit Blocks': Schema.optionalKey(Schema.Number),
  'Local Read Blocks': Schema.optionalKey(Schema.Number),
})
const Explain = Schema.Array(Schema.Struct({ 'QUERY PLAN': Schema.Array(Schema.Struct({ Plan })) }))

describePostgres('native risk valuation index coverage', () => {
  let runtime: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>
  beforeAll(() => {
    if (baynTestPostgresUrl === undefined) throw new Error('Missing disposable PostgreSQL endpoint')
    const url = new URL(baynTestPostgresUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('Risk valuation tests require an isolated local _test database')
    runtime = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(url.toString()), maxConnections: 1 }))
  })
  afterAll(async () => runtime?.dispose())

  test('preserves account, cutoff, session boundaries and tie-breaking without scanning history', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`CREATE TEMP TABLE valuations (
              valuation_id text PRIMARY KEY, account_id text NOT NULL, as_of timestamptz NOT NULL,
              equity_micros numeric NOT NULL
            ) ON COMMIT DROP`
            yield* sql`INSERT INTO valuations
              SELECT md5(i::text), 'fixture-account',
                '2026-01-01T00:00Z'::timestamptz + i * interval '1 minute', 100
              FROM generate_series(1, 12000) AS series(i)`
            yield* sql`INSERT INTO valuations VALUES
              ('prior-day', 'fixture-account', '2026-10-16T03:59:59Z', 250),
              ('opening-b', 'fixture-account', '2026-10-16T04:00Z', 300),
              ('opening-a', 'fixture-account', '2026-10-16T04:00Z', 200),
              ('current', 'fixture-account', '2026-10-16T16:00Z', 700),
              ('future', 'fixture-account', '2026-10-16T16:00:00.001Z', 9000),
              ('foreign', 'other-account', '2026-10-16T04:00Z', 99000)`
            yield* sql`ANALYZE valuations`
            const observedAt = '2026-10-16T16:00:00.000Z'
            const explain = (query: ReturnType<typeof peakEquityQuery>) =>
              sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Explain)),
                Effect.map((rows) => {
                  const plan = rows[0]?.['QUERY PLAN'][0]?.Plan
                  if (plan === undefined) throw new Error('Missing executed PostgreSQL plan')
                  return (
                    plan['Shared Hit Blocks'] +
                    plan['Shared Read Blocks'] +
                    (plan['Local Hit Blocks'] ?? 0) +
                    (plan['Local Read Blocks'] ?? 0)
                  )
                }),
              )
            const opening = firstSessionEquityQuery(sql, 'fixture-account', observedAt)
            const peak = peakEquityQuery(sql, 'fixture-account', observedAt)
            for (const query of [opening, peak]) expect(yield* explain(query)).toBeGreaterThan(64)
            yield* riskValuationIndexes.pipe(Effect.provideService(SqlClient.SqlClient, sql))
            yield* sql`ANALYZE valuations`
            for (const query of [opening, peak]) expect(yield* explain(query)).toBeLessThan(32)
            expect(yield* opening).toEqual([{ equity_micros: '200' }])
            expect(yield* peak).toEqual([{ equity_micros: '700' }])
            expect(yield* firstSessionEquityQuery(sql, 'missing-account', observedAt)).toEqual([])
            expect(yield* peakEquityQuery(sql, 'missing-account', observedAt)).toEqual([{ equity_micros: null }])

            // New York midnight changes offset across DST; UTC calendar dates are not substitutes.
            yield* sql`INSERT INTO valuations VALUES
              ('spring-prior', 'dst-account', '2026-03-08T04:59:59Z', 900),
              ('spring-open', 'dst-account', '2026-03-08T05:00Z', 400),
              ('spring-next', 'dst-account', '2026-03-09T04:00Z', 500),
              ('fall-prior', 'dst-account', '2026-11-01T03:59:59Z', 900),
              ('fall-open', 'dst-account', '2026-11-01T04:00Z', 600),
              ('fall-next', 'dst-account', '2026-11-02T05:00Z', 800)`
            expect(yield* firstSessionEquityQuery(sql, 'dst-account', '2026-03-09T03:59:59Z')).toEqual([
              { equity_micros: '400' },
            ])
            expect(yield* firstSessionEquityQuery(sql, 'dst-account', '2026-11-02T04:59:59Z')).toEqual([
              { equity_micros: '600' },
            ])
          }),
        )
      }),
    )
  })
})
