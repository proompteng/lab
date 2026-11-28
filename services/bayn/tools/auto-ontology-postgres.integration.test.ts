import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Redacted, Result, Schema } from 'effect'

import { postgresMigrations } from '../src/db/postgres-migrations'
import { provideTestLayer } from '../src/effect-test-support'
import { baynTestPostgresUrl } from '../src/test-environment.test-support'
import { BaynKnowledge, strictKnowledge } from './auto-ontology-knowledge'
import { verifyMigratedAnalyses } from './auto-ontology-postgres'
import { localPostgresTestUrl } from './postgres-test-databases'
import { prepareAnalysis, prepareKnowledge } from './sync-auto-ontology-core'

test.skipIf(baynTestPostgresUrl === undefined)(
  'PostgreSQL parses and binds the seed and fails closed on schema drift and writable CTEs',
  async () => {
    const seed = Schema.decodeUnknownSync(
      BaynKnowledge,
      strictKnowledge,
    )(await Bun.file(new URL('../../../docs/bayn/ontology/bayn-knowledge.json', import.meta.url)).json())
    const url = localPostgresTestUrl(baynTestPostgresUrl)
    const layer = Layer.mergeAll(
      NodeServices.layer,
      PgClient.layer({ url: Redacted.make(url.toString()), maxConnections: 1 }),
    )
    await Effect.runPromise(
      provideTestLayer(
        Effect.gen(function* () {
          yield* postgresMigrations
          yield* verifyMigratedAnalyses(Result.getOrThrow(prepareKnowledge(seed)))
          const sql = yield* PgClient.PgClient
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SET TRANSACTION READ ONLY`
              for (const analysis of seed.analyses) {
                const rows = yield* sql.unsafe(analysis.sql, [
                  'fixture-account',
                  '2026-11-25T05:00:00Z',
                  '2026-11-26T05:00:00Z',
                ])
                expect(rows).toEqual([])
              }
            }),
          )

          const analysis = seed.analyses[0]
          for (const query of [
            analysis.sql.replace('public.orders', 'public.nonexistent_orders'),
            analysis.sql.replace('o.order_type', 'o.nonexistent_order_type'),
            analysis.sql.replace('public.orders', 'orders'),
            'WITH changed AS (DELETE FROM public.fills WHERE account_id = $1::text RETURNING event_id) SELECT event_id FROM changed WHERE $2::timestamptz < $3::timestamptz',
          ]) {
            const prepared = Result.getOrThrow(prepareAnalysis({ ...analysis, sql: query }, 0))
            const result = yield* Effect.result(verifyMigratedAnalyses([prepared]))
            expect(result).toMatchObject({
              _tag: 'Failure',
              failure: { operation: 'analyses[0]', message: 'SELECT does not resolve against Bayn migrations' },
            })
          }
        }),
        layer,
      ),
    )
  },
  15000,
)
