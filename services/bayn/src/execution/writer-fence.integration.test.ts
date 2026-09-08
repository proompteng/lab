import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Redacted, Schema } from 'effect'

import { PostgresClientLive } from '../db/postgres-client'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { config as fixtureConfig } from '../testing/runtime-fixtures'
import { WriterFence, WriterFenceLive } from './writer-fence'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const config = {
  ...fixtureConfig,
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}
const makeRuntime = () =>
  ManagedRuntime.make(
    WriterFenceLive.pipe(Layer.provideMerge(PostgresClientLive(config)), Layer.provideMerge(NodeServices.layer)),
  )
const BackendRows = Schema.Tuple([Schema.Struct({ pid: Schema.Int })])

describePostgres('PostgreSQL writer fence lifecycle', () => {
  let runtime: ReturnType<typeof makeRuntime>
  let contender: ReturnType<typeof makeRuntime>

  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
    runtime = makeRuntime()
    contender = makeRuntime()
  })
  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`CREATE TABLE IF NOT EXISTS writer_fence_test (id integer PRIMARY KEY)`
        yield* sql`TRUNCATE writer_fence_test`
      }),
    )
  })
  afterAll(async () => {
    await runtime?.dispose()
    await contender?.dispose()
  })

  test('a disconnected transaction fails once and the same fence can commit the next transaction', async () => {
    const started = await Effect.runPromise(Deferred.make<number>())
    const disconnected = await Effect.runPromise(Deferred.make<void>())
    const attempt = runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        return yield* Effect.exit(
          fence.transaction(
            Effect.gen(function* () {
              const [{ pid }] = yield* sql`SELECT pg_backend_pid() AS pid`.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(BackendRows)),
              )
              yield* sql`INSERT INTO writer_fence_test VALUES (1)`
              yield* Deferred.succeed(started, pid)
              yield* Deferred.await(disconnected)
              yield* sql`INSERT INTO writer_fence_test VALUES (2)`
            }),
          ),
        )
      }),
    )
    const pid = await Effect.runPromise(Deferred.await(started))
    await contender.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`SELECT pg_terminate_backend(${pid}, 5000)`
      }).pipe(Effect.ensuring(Deferred.succeed(disconnected, undefined))),
    )
    const failed = await attempt
    expect(Exit.isFailure(failed)).toBe(true)
    if (Exit.isFailure(failed)) {
      const tags = failed.cause.reasons.flatMap((reason) => (Cause.isFailReason(reason) ? [reason.error._tag] : []))
      expect(tags).toEqual(['SqlError', 'WriterFenceError'])
    }

    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        yield* fence.transaction(sql`INSERT INTO writer_fence_test VALUES (3)`)
        return yield* sql`SELECT id FROM writer_fence_test ORDER BY id`
      }),
    )
    expect(rows).toEqual([{ id: 3 }])
  })

  test('nested fence calls share the transaction and roll back together on a typed failure', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        const exit = yield* Effect.exit(
          fence.transaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO writer_fence_test VALUES (1)`
              yield* fence.transaction(sql`INSERT INTO writer_fence_test VALUES (2)`)
              return yield* Effect.fail('rollback marker')
            }),
          ),
        )
        yield* fence.transaction(sql`INSERT INTO writer_fence_test VALUES (3)`)
        return { exit, rows: yield* sql`SELECT id FROM writer_fence_test ORDER BY id` }
      }),
    )
    expect(result.exit).toEqual(Exit.fail('rollback marker'))
    expect(result.rows).toEqual([{ id: 3 }])
  })

  test('a second fence cannot enter until the owning transaction commits', async () => {
    const started = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const attempt = runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        yield* fence.transaction(
          sql`INSERT INTO writer_fence_test VALUES (1)`.pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        )
      }),
    )
    await Effect.runPromise(Deferred.await(started))
    const blocked = await contender.runPromiseExit(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        yield* fence.transaction(sql`INSERT INTO writer_fence_test VALUES (2)`)
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined))),
    )
    await attempt
    expect(Exit.isFailure(blocked)).toBe(true)
    if (Exit.isFailure(blocked)) {
      expect(Cause.pretty(blocked.cause)).toContain('another PostgreSQL transaction owns the execution writer fence')
    }
    const rows = await contender.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        yield* fence.transaction(sql`INSERT INTO writer_fence_test VALUES (3)`)
        return yield* sql`SELECT id FROM writer_fence_test ORDER BY id`
      }),
    )
    expect(rows).toEqual([{ id: 1 }, { id: 3 }])
  })

  test('interruption rolls back, finalizes once, and releases the connection and lease', async () => {
    let finalizations = 0
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        const started = yield* Deferred.make<void>()
        const fiber = yield* fence
          .transaction(
            sql`INSERT INTO writer_fence_test VALUES (1)`.pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  finalizations += 1
                }),
              ),
            ),
          )
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        yield* fence.transaction(sql`INSERT INTO writer_fence_test VALUES (2)`)
        return { exit, rows: yield* sql`SELECT id FROM writer_fence_test ORDER BY id` }
      }),
    )
    expect(Exit.isFailure(result.exit)).toBe(true)
    if (Exit.isFailure(result.exit)) expect(Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
    expect(finalizations).toBe(1)
    expect(result.rows).toEqual([{ id: 2 }])
    await contender.runPromise(Effect.flatMap(WriterFence, (fence) => fence.check))
  })

  test('a defect remains a defect and rolls back its transaction', async () => {
    const defect = new Error('injected fence defect')
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        const exit = yield* Effect.exit(
          fence.transaction(sql`INSERT INTO writer_fence_test VALUES (1)`.pipe(Effect.andThen(Effect.die(defect)))),
        )
        yield* fence.check
        return { exit, rows: yield* sql`SELECT id FROM writer_fence_test` }
      }),
    )
    expect(result.exit).toEqual(Exit.die(defect))
    expect(result.rows).toEqual([])
  })
})
