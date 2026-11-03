import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createConnection, createServer, type Socket } from 'node:net'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Redacted, Schedule, Schema } from 'effect'

import { PostgresClientLive } from './db/postgres-client'
import { InferenceCostError } from './inference-costs'
import { withInferenceExpenseOwner } from './inference-expense-runtime'
import { baynTestPostgresUrl } from './test-environment.test-support'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const config = {
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}
const makeRuntime = () =>
  ManagedRuntime.make(
    PostgresClientLive(config, { maxConnections: 1, applicationName: 'bayn-expense-owner-test-observer' }).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
  )
const BackendRows = Schema.Tuple([Schema.Struct({ pid: Schema.Int })])
const backendPid = (sql: PgClient.PgClient) =>
  sql`SELECT pg_backend_pid()::integer AS pid`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(BackendRows)),
    Effect.map(([row]) => row.pid),
  )
const afterRelease = (postgres: PgClient.PgClientConfig, projection: string) =>
  withInferenceExpenseOwner(postgres, projection, () => Effect.succeed('replacement')).pipe(
    Effect.repeat({ while: (result) => result === undefined, schedule: Schedule.spaced('10 millis') }),
    Effect.timeout('3 seconds'),
  )

describePostgres('inference expense projection session ownership', () => {
  let runtime: ReturnType<typeof makeRuntime>

  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    runtime = makeRuntime()
  })
  afterAll(async () => {
    await runtime?.dispose()
  })

  test('skips a duplicate pass without blocking independent accounts or research and closes the interrupted owner', async () => {
    let skippedExecutions = 0
    let finalizations = 0
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const observer = yield* PgClient.PgClient
          const projection = `account:${crypto.randomUUID()}`
          const started = yield* Deferred.make<number>()
          const owner = yield* withInferenceExpenseOwner(observer.config, projection, (sql) =>
            backendPid(sql).pipe(
              Effect.flatMap((pid) => Deferred.succeed(started, pid)),
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.sync(() => finalizations++)),
            ),
          ).pipe(Effect.forkScoped)
          const pid = yield* Deferred.await(started).pipe(Effect.raceFirst(Fiber.join(owner)))
          expect(
            yield* observer`SELECT state, xact_start IS NULL AS autocommit FROM pg_stat_activity WHERE pid=${pid}`,
          ).toEqual([{ state: 'idle', autocommit: true }])
          expect(
            yield* withInferenceExpenseOwner(observer.config, projection, () => Effect.sync(() => skippedExecutions++)),
          ).toBeUndefined()
          expect(yield* withInferenceExpenseOwner(observer.config, 'research', () => Effect.succeed('research'))).toBe(
            'research',
          )
          expect(
            yield* withInferenceExpenseOwner(observer.config, `${projection}:other`, () => Effect.succeed('other')),
          ).toBe('other')
          yield* Fiber.interrupt(owner)
          const exit = yield* Fiber.await(owner)
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          expect(yield* afterRelease(observer.config, projection)).toBe('replacement')
          expect(yield* observer`SELECT pid FROM pg_stat_activity WHERE pid=${pid}`).toEqual([])
        }),
      ),
    )
    expect(skippedExecutions).toBe(0)
    expect(finalizations).toBe(1)
  })

  test('commits ordinary statements before external work and permits bounded inner transactions', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const observer = yield* PgClient.PgClient
        const projection = `account:${crypto.randomUUID()}`
        const pid = yield* withInferenceExpenseOwner(observer.config, projection, (sql) =>
          Effect.gen(function* () {
            const pid = yield* backendPid(sql)
            yield* sql.withTransaction(sql`SELECT 1`)
            expect(
              yield* observer`SELECT state, xact_start IS NULL AS autocommit FROM pg_stat_activity WHERE pid=${pid}`,
            ).toEqual([{ state: 'idle', autocommit: true }])
            return pid
          }),
        )
        expect(pid).toBeNumber()
        expect(yield* afterRelease(observer.config, projection)).toBe('replacement')
        expect(yield* observer`SELECT pid FROM pg_stat_activity WHERE pid=${pid}`).toEqual([])
      }),
    )
  })

  test('retains ownership and acknowledges after external work exceeds the normal socket inactivity deadline', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const observer = yield* PgClient.PgClient
        const postgres = yield* PgClient.PgClient.pipe(
          Effect.map((sql) => sql.config),
          Effect.provide(
            PostgresClientLive(
              { ...config, operationTimeoutMs: 2_000 },
              { maxConnections: 1, applicationName: 'bayn-expense-owner-long-ledger' },
            ),
          ),
        )
        const projection = `account:${crypto.randomUUID()}`
        const pid = yield* withInferenceExpenseOwner(postgres, projection, (sql) =>
          Effect.gen(function* () {
            const pid = yield* backendPid(sql)
            // This real socket's existing inactivity deadline is 1.5 seconds.
            yield* Effect.sleep('2 seconds')
            expect(
              yield* withInferenceExpenseOwner(observer.config, projection, () => Effect.succeed('duplicate')),
            ).toBeUndefined()
            // The post-ledger acknowledgement must still use the original, live owner session.
            expect(yield* backendPid(sql)).toBe(pid)
            return pid
          }),
        )
        expect(yield* afterRelease(observer.config, projection)).toBe('replacement')
        expect(yield* observer`SELECT pid FROM pg_stat_activity WHERE pid=${pid}`).toEqual([])
      }),
    )
  }, 10_000)

  test('interrupts external work when the ownership session is lost and allows a replacement', async () => {
    let finalizations = 0
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const observer = yield* PgClient.PgClient
          const projection = `account:${crypto.randomUUID()}`
          const started = yield* Deferred.make<number>()
          const owner = yield* withInferenceExpenseOwner(observer.config, projection, (sql) =>
            backendPid(sql).pipe(
              Effect.flatMap((pid) => Deferred.succeed(started, pid)),
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.sync(() => finalizations++)),
            ),
          ).pipe(Effect.forkScoped)
          const pid = yield* Deferred.await(started).pipe(Effect.raceFirst(Fiber.join(owner)))
          yield* observer`SELECT pg_terminate_backend(${pid})`
          const exit = yield* Fiber.await(owner).pipe(Effect.timeout('3 seconds'))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const [reason] = exit.cause.reasons
            expect(reason?._tag).toBe('Fail')
            if (reason?._tag === 'Fail')
              expect(reason.error).toMatchObject({
                _tag: 'InferenceCostError',
                message: 'Inference expense ownership session was lost',
              })
          }
          expect(finalizations).toBe(1)
          expect(yield* afterRelease(observer.config, projection)).toBe('replacement')
          expect(yield* observer`SELECT pid FROM pg_stat_activity WHERE pid=${pid}`).toEqual([])
        }),
      ),
    )
  })

  for (const failure of ['typed', 'defect', 'timeout'] as const)
    test(`closes the physical session and retains a ${failure} failure`, async () => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const observer = yield* PgClient.PgClient
          const projection = `account:${crypto.randomUUID()}`
          let pid: number | undefined
          const failureEffect = Effect.gen(function* () {
            if (failure === 'typed') return yield* new InferenceCostError({ message: 'synthetic ledger failure' })
            if (failure === 'defect') return yield* Effect.die('synthetic ledger defect')
            return yield* Effect.never.pipe(Effect.timeout('20 millis'))
          })
          const exit = yield* withInferenceExpenseOwner(observer.config, projection, (sql) =>
            backendPid(sql).pipe(
              Effect.tap((value) => Effect.sync(() => (pid = value))),
              Effect.andThen(failureEffect),
            ),
          ).pipe(Effect.exit)
          expect(pid).toBeNumber()
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const [reason] = exit.cause.reasons
            expect(reason?._tag).toBe(failure === 'defect' ? 'Die' : 'Fail')
          }
          expect(yield* afterRelease(observer.config, projection)).toBe('replacement')
          expect(yield* observer`SELECT pid FROM pg_stat_activity WHERE pid=${pid}`).toEqual([])
        }),
      )
    })

  test('releases a lock whose successful acquisition response was lost before the pass began', async () => {
    const target = new URL(testUrl)
    const upstreamAddress = { host: target.hostname, port: Number(target.port || 5432) }
    const sockets = new Set<Socket>()
    let discardedResponses = 0
    let passExecutions = 0
    const proxy = createServer((downstream) => {
      const upstream = createConnection(upstreamAddress)
      sockets.add(upstream)
      sockets.add(downstream)
      let recent = Buffer.alloc(0)
      let discard = false
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
      downstream.on('data', (data: Buffer) => {
        recent = Buffer.concat([recent, data])
        if (recent.includes('pg_try_advisory_lock')) discard = true
        recent = recent.subarray(-64)
        upstream.write(data)
      })
      upstream.on('data', (data: Buffer) => {
        if (discard) discardedResponses++
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
    const applicationName = `bayn-expense-owner-lost-${crypto.randomUUID()}`
    try {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const observer = yield* PgClient.PgClient
            const postgres = yield* PgClient.PgClient.pipe(
              Effect.map((sql) => sql.config),
              Effect.provide(
                PostgresClientLive(
                  {
                    ...config,
                    operationTimeoutMs: 2_000,
                    postgres: { ...config.postgres, url: Redacted.make(target.toString()) },
                  },
                  { maxConnections: 1, applicationName },
                ),
              ),
            )
            const projection = `account:${crypto.randomUUID()}`
            const owner = yield* withInferenceExpenseOwner(postgres, projection, () =>
              Effect.sync(() => passExecutions++),
            ).pipe(Effect.forkScoped)
            const held = yield* observer`SELECT EXISTS (
              SELECT 1 FROM pg_locks lock JOIN pg_stat_activity backend ON backend.pid=lock.pid
              WHERE lock.locktype='advisory' AND lock.granted AND backend.application_name=${applicationName}
            ) AS held`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ held: Schema.Boolean })]))),
              Effect.map(([row]) => row.held),
              Effect.repeat({ while: (held) => !held, schedule: Schedule.spaced('10 millis') }),
              Effect.timeout('1 second'),
            )
            expect(held).toBe(true)
            expect(
              yield* withInferenceExpenseOwner(observer.config, projection, () => Effect.succeed('duplicate')),
            ).toBeUndefined()
            yield* Fiber.interrupt(owner)
            const exit = yield* Fiber.await(owner)
            expect(Exit.isFailure(exit)).toBe(true)
            expect(yield* afterRelease(observer.config, projection)).toBe('replacement')
            expect(yield* observer`SELECT pid FROM pg_stat_activity WHERE application_name=${applicationName}`).toEqual(
              [],
            )
          }),
        ),
      )
      expect(passExecutions).toBe(0)
      expect(discardedResponses).toBeGreaterThan(0)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())))
    }
  }, 10_000)
})
