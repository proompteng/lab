import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Deferred, Effect, Exit, Fiber, ManagedRuntime, Redacted, Schema } from 'effect'

import { baynTestPostgresUrl } from '../test-environment.test-support'
import { openSnapshotRows } from './snapshot-rows'

const postgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const RowSchema = Schema.Struct({ id: Schema.Int, payload: Schema.Unknown })

postgres('bounded PostgreSQL snapshot rows', () => {
  let runtime: ManagedRuntime.ManagedRuntime<PgClient.PgClient, unknown>
  let url: string
  beforeAll(async () => {
    const parsed = new URL(baynTestPostgresUrl ?? '')
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('Snapshot row tests require an isolated local _test database')
    parsed.searchParams.set('options', '-c search_path=bayn_snapshot_rows_test')
    url = parsed.toString()
    runtime = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(url), maxConnections: 4 }))
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`CREATE SCHEMA bayn_snapshot_rows_test`
        yield* sql`CREATE TABLE entries(id integer PRIMARY KEY, payload jsonb NOT NULL)`
      }),
    )
  })
  beforeEach(() =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`TRUNCATE entries`
        yield* sql`INSERT INTO entries SELECT id, '{}'::jsonb FROM generate_series(1, 130) AS id`
      }),
    ),
  )
  afterAll(async () => {
    if (runtime !== undefined) {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql`DROP SCHEMA bayn_snapshot_rows_test CASCADE`
        }),
      )
      await runtime.dispose()
    }
  })

  test.each([1, 64])(
    'keeps the opening snapshot across %s-row fetches after a concurrent commit',
    async (batchSize) => {
      const seen = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const opened = yield* Deferred.make<void>()
          const changed = yield* Deferred.make<void>()
          const reader = yield* Effect.forkChild(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`
                const consume = yield* openSnapshotRows(
                  sql,
                  sql`SELECT id, payload FROM entries ORDER BY id`,
                  batchSize,
                )
                expect(
                  yield* sql`SELECT count(*)::integer AS count FROM pg_cursors WHERE name LIKE 'bayn_snapshot_%'`,
                ).toEqual([{ count: 1 }])
                yield* Deferred.succeed(opened, undefined)
                yield* Deferred.await(changed)
                const rows: number[] = []
                yield* consume((input) =>
                  Effect.gen(function* () {
                    const row = yield* Schema.decodeUnknownEffect(RowSchema)(input)
                    rows.push(row.id)
                  }),
                )
                return rows
              }),
            ),
          )
          yield* Deferred.await(opened)
          yield* sql`INSERT INTO entries VALUES (131, '{}'::jsonb)`
          yield* Deferred.succeed(changed, undefined)
          return yield* Fiber.join(reader)
        }).pipe(Effect.scoped),
      )
      expect(seen).toEqual(Array.from({ length: 130 }, (_, index) => index + 1))
    },
  )

  test.each(['interruption', 'failure'] as const)(
    'closes its cursor and reuses the connection after %s',
    async (mode) => {
      const single = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))
      try {
        await single.runPromise(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            const pidRows = yield* sql`SELECT pg_backend_pid() AS pid`
            const first = yield* Deferred.make<void>()
            const operation = sql.withTransaction(
              Effect.gen(function* () {
                const consume = yield* openSnapshotRows(sql, sql`SELECT id, payload FROM entries ORDER BY id`, 64)
                yield* consume((input) =>
                  Effect.gen(function* () {
                    const row = yield* Schema.decodeUnknownEffect(RowSchema)(input)
                    if (row.id !== 70) return
                    yield* Deferred.succeed(first, undefined)
                    return yield* mode === 'failure' ? Effect.fail('source consumer failed') : Effect.never
                  }),
                )
              }),
            )
            if (mode === 'interruption') {
              const fiber = yield* Effect.forkChild(operation)
              yield* Deferred.await(first)
              yield* Fiber.interrupt(fiber)
            } else expect(Exit.isFailure(yield* Effect.exit(operation))).toBe(true)
            expect(yield* sql`SELECT pg_backend_pid() AS pid`).toEqual(pidRows)
            expect(
              yield* sql`SELECT count(*)::integer AS count FROM pg_cursors WHERE name LIKE 'bayn_snapshot_%'`,
            ).toEqual([{ count: 0 }])
          }).pipe(Effect.scoped),
        )
      } finally {
        await single.dispose()
      }
    },
  )
})
