import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import * as PgConnection from '@effect/sql-pg/PgConnection'
import { Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Redacted, Schedule, Schema } from 'effect'

import { PostgresClientLive } from './db/postgres-client'
import { listenInferenceExpenses, withInferenceExpenseOwner } from './inference-expense-runtime'
import { baynTestPostgresUrl } from './test-environment.test-support'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const config = {
  operationTimeoutMs: 2_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}
const makeRuntime = () =>
  ManagedRuntime.make(
    PostgresClientLive(config, { maxConnections: 2, applicationName: 'bayn-expense-listener-observer' }).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
  )
const idle = { pending: false, nextWakeAt: null }
const ListenerRows = Schema.Tuple([
  Schema.Struct({ pid: Schema.Int, autocommit: Schema.Boolean, heartbeatActive: Schema.Boolean, idle: Schema.Boolean }),
])
const listener = (sql: PgClient.PgClient, applicationName: string) =>
  sql`SELECT pid::integer, xact_start IS NULL AS autocommit,
    state='active' AND query='SELECT 1' AS "heartbeatActive", state='idle' AS idle
    FROM pg_stat_activity WHERE application_name=${applicationName}`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ListenerRows)),
    Effect.map(([row]) => row),
  )
const idleListener = (sql: PgClient.PgClient, applicationName: string) =>
  listener(sql, applicationName).pipe(
    Effect.flatMap((row) =>
      row.heartbeatActive
        ? Effect.fail('listener heartbeat active' as const)
        : row.idle && row.autocommit
          ? Effect.succeed(row)
          : Effect.fail('listener session is not idle outside a transaction' as const),
    ),
    // An autocommit SELECT has xact_start while active. Only that in-flight heartbeat may settle and retry.
    Effect.retry({
      schedule: Schedule.spaced('10 millis'),
      times: 50,
      while: (failure) => failure === 'listener heartbeat active',
    }),
  )

const awaitListenerClosed = (sql: PgClient.PgClient, applicationName: string) =>
  sql`SELECT pid FROM pg_stat_activity WHERE application_name=${applicationName}`.pipe(
    // PgConnection release flushes Terminate locally; it does not await the peer's backend exit.
    // Observe that exit within a hard bound without retrying SQL failures or accepting a leaked session.
    Effect.repeat({ while: (rows) => rows.length > 0, schedule: Schedule.spaced('10 millis') }),
    Effect.timeout('2 seconds'),
  )

describePostgres('inference expense LISTEN lifecycle', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    runtime = makeRuntime()
  })
  afterAll(async () => runtime?.dispose())

  test('LISTEN ACK precedes startup drain and retains a commit while that drain is blocked', async () => {
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const channel = `bayn_expense_${crypto.randomUUID().replaceAll('-', '')}`
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const drained = yield* Deferred.make<void>()
          let starts = 0
          const fiber = yield* listenInferenceExpenses(
            sql.config,
            channel,
            Effect.gen(function* () {
              if (++starts === 1) {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              } else yield* Deferred.succeed(drained, undefined)
              return idle
            }),
          ).pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          yield* sql.notify(channel, '')
          yield* Deferred.succeed(release, undefined)
          yield* Deferred.await(drained).pipe(Effect.timeout('2 seconds'))
          expect(starts).toBe(2)
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )
  })

  test('only committed hints wake both replicas, while independent channels cannot steal notifications', async () => {
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const channel = `bayn_expense_${crypto.randomUUID().replaceAll('-', '')}`
          const started = yield* Deferred.make<void>()
          const finished = yield* Deferred.make<void>()
          let accountStarts = 0
          let researchStarts = 0
          const pass = Effect.sync(() => {
            if (++accountStarts === 2) Deferred.doneUnsafe(started, Exit.void)
            if (accountStarts === 4) Deferred.doneUnsafe(finished, Exit.void)
            return idle
          })
          const first = yield* listenInferenceExpenses(sql.config, channel, pass).pipe(Effect.forkScoped)
          const second = yield* listenInferenceExpenses(sql.config, channel, pass).pipe(Effect.forkScoped)
          const research = yield* listenInferenceExpenses(
            sql.config,
            `${channel}_r`,
            Effect.sync(() => {
              researchStarts++
              return idle
            }),
          ).pipe(Effect.forkScoped)
          yield* Deferred.await(started)
          yield* sql
            .withTransaction(sql`SELECT pg_notify(${channel}, '')`.pipe(Effect.andThen(Effect.fail('rollback'))))
            .pipe(Effect.result)
          yield* Effect.sleep('30 millis')
          expect(accountStarts).toBe(2)
          expect(researchStarts).toBe(1)
          yield* sql.withTransaction(sql`SELECT pg_notify(${channel}, '')`)
          yield* Deferred.await(finished).pipe(Effect.timeout('2 seconds'))
          expect(accountStarts).toBe(4)
          expect(researchStarts).toBe(1)
          yield* Fiber.interrupt(first)
          yield* Fiber.interrupt(second)
          yield* Fiber.interrupt(research)
        }),
      ),
    )
  })

  test('reconnect drains retained changes committed while no listener was connected', async () => {
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const table = `expense_listener_${crypto.randomUUID().replaceAll('-', '')}`
          yield* sql`CREATE TABLE ${sql(table)} (value integer NOT NULL)`
          yield* Effect.addFinalizer(() => sql`DROP TABLE ${sql(table)}`.pipe(Effect.orDie))
          const applicationName = `expense-reconnect-${crypto.randomUUID()}`
          const postgres = { ...sql.config, applicationName }
          const entered = yield* Deferred.make<void>()
          const disconnected = yield* Deferred.make<void>()
          const recovered = yield* Deferred.make<void>()
          const values: number[] = []
          const projection = listenInferenceExpenses(
            postgres,
            'bayn_expense_reconnect_test',
            Effect.gen(function* () {
              const [{ value }] = yield* sql`SELECT COALESCE(SUM(value),0)::integer AS value FROM ${sql(table)}`.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ value: Schema.Int })]))),
              )
              values.push(value)
              if (value === 0) yield* Deferred.succeed(entered, undefined)
              else yield* Deferred.succeed(recovered, undefined)
              return idle
            }),
          ).pipe(
            Effect.tapError(() => Deferred.succeed(disconnected, undefined)),
            Effect.retry({ schedule: Schedule.spaced('200 millis') }),
          )
          const fiber = yield* projection.pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          const before = yield* listener(sql, applicationName)
          yield* sql`SELECT pg_terminate_backend(${before.pid})`
          yield* Deferred.await(disconnected).pipe(Effect.timeout('2 seconds'))
          // This commit has no retained notification. The reconnect's startup drain is its recovery path.
          yield* sql`INSERT INTO ${sql(table)} VALUES (7)`
          yield* Deferred.await(recovered).pipe(Effect.timeout('2 seconds'))
          expect(values).toEqual([0, 7])
          expect((yield* listener(sql, applicationName)).pid).not.toBe(before.pid)
          yield* Fiber.interrupt(fiber)
          expect(yield* awaitListenerClosed(sql, applicationName)).toEqual([])
        }),
      ),
    )
  })

  test('keeps the exact idle LISTEN socket alive past its inactivity deadline without opening a transaction', async () => {
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const applicationName = `expense-heartbeat-${crypto.randomUUID()}`
          const entered = yield* Deferred.make<void>()
          let starts = 0
          const fiber = yield* listenInferenceExpenses(
            { ...sql.config, applicationName },
            'bayn_expense_heartbeat_test',
            Effect.sync(() => {
              starts++
              Deferred.doneUnsafe(entered, Exit.void)
              return idle
            }),
          ).pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          const before = yield* listener(sql, applicationName)
          yield* Effect.sleep('2500 millis')
          expect(yield* idleListener(sql, applicationName)).toEqual(before)
          expect(before.autocommit).toBe(true)
          expect(starts).toBe(1)
          yield* Fiber.interrupt(fiber)
          expect(yield* awaitListenerClosed(sql, applicationName)).toEqual([])
        }),
      ),
    )
  })

  test('cleanup observation fails within its deadline while the session is still open', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const applicationName = `expense-held-session-${crypto.randomUUID()}`
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* PgConnection.make({
              ...sql.config,
              applicationName,
              connectTimeout: '10 seconds',
            })
            const pinned = yield* connection.pin
            yield* pinned.query('SELECT 1')
            const before = yield* idleListener(sql, applicationName)
            const failure = yield* awaitListenerClosed(sql, applicationName).pipe(
              Effect.match({ onFailure: (cause) => cause._tag, onSuccess: () => null }),
            )
            expect(failure).toBe('TimeoutError')
            expect(yield* idleListener(sql, applicationName)).toEqual(before)
          }),
        )
        expect(yield* awaitListenerClosed(sql, applicationName)).toEqual([])
      }),
    )
  })

  test('idle socket observation rejects a session held in a transaction', async () => {
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const applicationName = `expense-held-transaction-${crypto.randomUUID()}`
          const connection = yield* PgConnection.make({ ...sql.config, applicationName })
          const pinned = yield* connection.pin
          yield* pinned.query('BEGIN')
          yield* Effect.addFinalizer(() => pinned.query('ROLLBACK').pipe(Effect.orDie))
          yield* pinned.query('SELECT 1')
          const result = yield* idleListener(sql, applicationName).pipe(
            Effect.match({ onFailure: (failure) => failure, onSuccess: () => null }),
          )
          expect(result).toBe('listener session is not idle outside a transaction')
        }),
      ),
    )
  })

  test('a busy replica takes over after its posting owner crashes without another domain hint', async () => {
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const projection = `account:${crypto.randomUUID()}`
          const channel = `bayn_expense_${crypto.randomUUID().replaceAll('-', '')}`
          const entered = yield* Deferred.make<number>()
          const recovered = yield* Deferred.make<void>()
          let attempts = 0
          let posts = 0
          const winner = yield* withInferenceExpenseOwner(sql.config, projection, (owner) =>
            owner`SELECT pg_backend_pid()::integer AS pid`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ pid: Schema.Int })]))),
              Effect.flatMap(([row]) => Deferred.succeed(entered, row.pid)),
              Effect.andThen(Effect.never),
            ),
          ).pipe(Effect.forkScoped)
          const pid = yield* Deferred.await(entered)
          const loser = yield* listenInferenceExpenses(
            sql.config,
            channel,
            Effect.sync(() => attempts++).pipe(
              Effect.andThen(
                withInferenceExpenseOwner(sql.config, projection, () =>
                  Effect.sync(() => {
                    posts++
                    Deferred.doneUnsafe(recovered, Exit.void)
                    return idle
                  }),
                ),
              ),
            ),
          ).pipe(Effect.forkScoped)
          yield* Effect.sleep('30 millis')
          expect(attempts).toBe(1)
          expect(posts).toBe(0)
          yield* sql`SELECT pg_terminate_backend(${pid})`
          yield* Deferred.await(recovered).pipe(Effect.timeout('2 seconds'))
          expect(posts).toBe(1)
          const after = attempts
          yield* Effect.sleep('1100 millis')
          expect(attempts).toBe(after)
          yield* Fiber.interrupt(winner)
          yield* Fiber.interrupt(loser)
        }),
      ),
    )
  })
})
