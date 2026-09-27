import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createConnection, createServer, type Socket } from 'node:net'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Redacted, Schema } from 'effect'
import type { Connection } from 'effect/unstable/sql/SqlConnection'
import { isSqlError } from 'effect/unstable/sql/SqlError'

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
const makeRuntime = (runtimeConfig = config) =>
  ManagedRuntime.make(
    WriterFenceLive.pipe(Layer.provideMerge(PostgresClientLive(runtimeConfig)), Layer.provideMerge(NodeServices.layer)),
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

  test('the server cancels stalled SQL before the pass deadline and rolls back its writer transaction', async () => {
    const exit = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        return yield* Effect.exit(
          fence
            .transaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO writer_fence_test VALUES (1)`
                yield* sql`SELECT pg_sleep(8)`
              }),
            )
            .pipe(Effect.timeout(config.operationTimeoutMs)),
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
        yield* fence.transaction(sql`INSERT INTO writer_fence_test VALUES (2)`)
        return yield* sql`SELECT id FROM writer_fence_test ORDER BY id`
      }),
    )
    expect(rows).toEqual([{ id: 2 }])
  }, 15_000)

  test('canceling queued writers returns every late connection without waiting for unrelated borrowers', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const fence = yield* WriterFence
        const poolConnections = 8
        const occupied = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const borrowers = yield* Effect.gen(function* () {
          for (let index = 0; index < poolConnections; index += 1) yield* sql.reserve
          yield* Deferred.succeed(occupied, undefined)
          yield* Deferred.await(release)
        }).pipe(Effect.scoped, Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(occupied)
        let mutated = false
        for (let index = 0; index < 2; index += 1) {
          const attempt = yield* fence
            .transaction(
              Effect.sync(() => {
                mutated = true
              }),
            )
            .pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.sleep('100 millis')
          yield* Fiber.interrupt(attempt).pipe(Effect.timeout('500 millis'))
          expect(attempt.pollUnsafe()).toBeDefined()
        }
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(borrowers)
        expect(mutated).toBe(false)
        const reacquired = yield* Effect.gen(function* () {
          for (let index = 0; index < poolConnections; index += 1) yield* sql.reserve
        }).pipe(Effect.scoped, Effect.timeoutOption('500 millis'))
        expect(Option.isSome(reacquired)).toBe(true)
        yield* fence.transaction(sql`INSERT INTO writer_fence_test VALUES (3)`)
        expect(yield* sql`SELECT id FROM writer_fence_test`).toEqual([{ id: 3 }])
      }),
    )
  }, 10000)

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

  test.each(['BEGIN', 'pg_try_advisory_xact_lock', 'pg_locks'])(
    'canceling a lost %s response rolls back before releasing the writer connection',
    async (statement) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const started = yield* Deferred.make<void>()
          const response = yield* Deferred.make<void>()
          const finalizations: string[] = []
          let injected = false
          let releases = 0
          const reserve = sql.reserve.pipe(
            Effect.tap(() =>
              Effect.addFinalizer(() =>
                Effect.sync(() => {
                  releases += 1
                }),
              ),
            ),
            Effect.map((connection) => {
              const delayResponse = (query: string) =>
                Effect.gen(function* () {
                  if (injected || !query.includes(statement)) return
                  injected = true
                  // PostgreSQL has already executed the statement; only its acknowledgment is withheld.
                  yield* connection.executeUnprepared('INSERT INTO writer_fence_test VALUES (1)', [], undefined)
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(response)
                })
              const executeUnprepared: Connection['executeUnprepared'] = (...args) =>
                connection.executeUnprepared(...args).pipe(
                  Effect.tap(() => {
                    if (args[0] === 'COMMIT' || args[0] === 'ROLLBACK') finalizations.push(args[0])
                    return delayResponse(args[0])
                  }),
                )
              const executeValues: Connection['executeValues'] = (...args) =>
                connection.executeValues(...args).pipe(Effect.tap(() => delayResponse(args[0])))
              return new Proxy(connection, {
                get(target, property, receiver) {
                  if (property === 'executeUnprepared') return executeUnprepared
                  if (property === 'executeValues') return executeValues
                  return Reflect.get(target, property, receiver)
                },
              })
            }),
          )
          const client = new Proxy(sql, {
            get(target, property, receiver) {
              return property === 'reserve' ? reserve : Reflect.get(target, property, receiver)
            },
          })
          yield* Effect.gen(function* () {
            const fence = yield* WriterFence
            const attempt = yield* fence
              .transaction(sql`INSERT INTO writer_fence_test VALUES (2)`)
              .pipe(Effect.forkChild({ startImmediately: true }))
            yield* Deferred.await(started).pipe(Effect.raceFirst(Fiber.join(attempt)))
            const interruption = yield* Fiber.interrupt(attempt).pipe(Effect.forkChild({ startImmediately: true }))
            const completedBeforeResponse = yield* Fiber.await(attempt).pipe(Effect.timeoutOption('1 second'))
            yield* Deferred.succeed(response, undefined)
            yield* Fiber.join(interruption)
            const exit = yield* Fiber.await(attempt)
            expect(Option.isSome(completedBeforeResponse)).toBe(true)
            expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
            expect(finalizations).toEqual(['ROLLBACK'])
            expect(releases).toBe(1)
            yield* fence.transaction(sql`INSERT INTO writer_fence_test VALUES (3)`)
            expect(yield* sql`SELECT id FROM writer_fence_test ORDER BY id`).toEqual([{ id: 3 }])
          }).pipe(
            Effect.provide(WriterFenceLive.pipe(Layer.provide(Layer.succeed(PgClient.PgClient, client)), Layer.fresh)),
          )
        }),
      )
      await contender.runPromise(Effect.flatMap(WriterFence, (fence) => fence.check))
    },
    10_000,
  )

  test('a blackholed PostgreSQL response closes the connection before recovery needs the writer permit', async () => {
    const target = new URL(testUrl)
    const upstreamAddress = { host: target.hostname, port: Number(target.port || 5432) }
    const sockets = new Set<Socket>()
    let blackhole = false
    let discardedResponses = 0
    const proxy = createServer((downstream) => {
      const upstream = createConnection(upstreamAddress)
      sockets.add(upstream)
      sockets.add(downstream)
      upstream.on('error', () => downstream.destroy())
      downstream.on('error', () => upstream.destroy())
      upstream.on('close', () => {
        sockets.delete(upstream)
        downstream.destroy()
      })
      downstream.on('close', () => {
        sockets.delete(downstream)
        upstream.destroy()
      })
      downstream.pipe(upstream)
      upstream.on('data', (data: Buffer) => {
        if (blackhole) discardedResponses += 1
        else downstream.write(data)
      })
    })
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject)
      proxy.listen(0, '127.0.0.1', resolve)
    })
    const address = proxy.address()
    if (address === null || typeof address === 'string') throw new Error('expected a local PostgreSQL proxy port')
    target.port = String(address.port)
    const faultRuntime = makeRuntime({
      ...config,
      operationTimeoutMs: 2_000,
      postgres: { ...config.postgres, url: Redacted.make(target.toString()) },
    })
    try {
      await faultRuntime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const fence = yield* WriterFence
          yield* fence.check
          blackhole = true
          const attempt = yield* fence
            .transaction(sql`INSERT INTO writer_fence_test VALUES (1)`)
            .pipe(Effect.forkChild({ startImmediately: true }))
          const completedWithoutNetworkRecovery = yield* Fiber.await(attempt).pipe(Effect.timeoutOption('3 seconds'))
          blackhole = false
          // Always clear the injected fault, including when checking the unfixed implementation.
          if (Option.isNone(completedWithoutNetworkRecovery)) {
            for (const socket of sockets) socket.destroy()
          }
          const exit = yield* Fiber.await(attempt)
          expect(Option.isSome(completedWithoutNetworkRecovery)).toBe(true)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(discardedResponses).toBeGreaterThan(0)
          yield* fence.transaction(sql`INSERT INTO writer_fence_test VALUES (3)`)
          expect(yield* sql`SELECT id FROM writer_fence_test ORDER BY id`).toEqual([{ id: 3 }])
        }),
      )
    } finally {
      blackhole = false
      for (const socket of sockets) socket.destroy()
      await faultRuntime.dispose()
      await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())))
    }
    await contender.runPromise(Effect.flatMap(WriterFence, (fence) => fence.check))
  }, 10_000)

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
    expect(result.exit).toMatchObject({
      _tag: 'Failure',
      cause: { reasons: [{ _tag: 'Fail', error: 'rollback marker' }] },
    })
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
    expect(result.exit).toMatchObject({ _tag: 'Failure', cause: { reasons: [{ _tag: 'Die', defect }] } })
    if (Exit.isFailure(result.exit)) {
      const [reason] = result.exit.cause.reasons
      expect(reason !== undefined && Cause.isDieReason(reason) && reason.defect === defect).toBe(true)
    }
    expect(result.rows).toEqual([])
  })
})
