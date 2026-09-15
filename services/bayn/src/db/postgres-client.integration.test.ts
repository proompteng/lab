import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Exit, Layer, ManagedRuntime, Redacted } from 'effect'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import { WriterFence, WriterFenceLive } from '../execution/writer-fence'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { PostgresClientLive } from './postgres-client'

const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const makeRuntime = () =>
  ManagedRuntime.make(
    WriterFenceLive.pipe(
      Layer.provideMerge(
        PostgresClientLive({
          operationTimeoutMs: 2_000,
          postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  )

describePostgres('PostgreSQL execution deadlines', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(async () => {
    const url = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
      throw new Error('PostgreSQL deadline tests require a local database ending in _test')
    runtime = makeRuntime()
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`CREATE TABLE IF NOT EXISTS postgres_deadline_test (id integer PRIMARY KEY)`
        yield* sql`TRUNCATE postgres_deadline_test`
      }),
    )
  })
  afterAll(async () => {
    await runtime?.dispose()
  })

  test('the server cancels stalled SQL before the pass deadline and rolls back its writer transaction', async () => {
    const exit = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        return yield* Effect.exit(
          fence
            .transaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO postgres_deadline_test VALUES (1)`
                yield* sql`SELECT pg_sleep(3)`
              }),
            )
            .pipe(Effect.timeout(2_000)),
        )
      }),
    )
    const reasons = Exit.isFailure(exit)
      ? exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) && isSqlError(reason.error) ? [reason.error.reason._tag] : [],
        )
      : []
    expect(reasons).toEqual(['StatementTimeoutError'])
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        yield* fence.transaction(sql`INSERT INTO postgres_deadline_test VALUES (2)`)
        return yield* sql`SELECT id FROM postgres_deadline_test ORDER BY id`
      }),
    )
    expect(rows).toEqual([{ id: 2 }])
  }, 15_000)
})
