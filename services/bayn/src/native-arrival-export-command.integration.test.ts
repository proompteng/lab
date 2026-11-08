import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { ConfigProvider, Effect, FileSystem, Layer, ManagedRuntime, Redacted, Result, Schedule, Schema } from 'effect'

import { nativeArrivalArchiveMigrations } from './db/native-arrival-archive'
import { makeNativeArrivalStore } from './db/native-arrival-postgres'
import { PostgresClientLive } from './db/postgres-client'
import { nativeArrivalExportFixture } from './intraday-replay/native-arrival-export.test-support'
import { runNativeArrivalExportCommand } from './native-arrival-export-command'
import { baynTestPostgresUrl } from './test-environment.test-support'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55436/bayn_native_arrival_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const postgres = { url: Redacted.make(testUrl), tls: false, caPath: '/unused' }
const writableUrl = new URL(testUrl)
writableUrl.searchParams.set('options', '-c default_transaction_read_only=off')
const reader = PostgresClientLive(
  { postgres: { ...postgres, url: Redacted.make(writableUrl.toString()) }, operationTimeoutMs: 30_000 },
  {
    maxConnections: 1,
    applicationName: 'bayn-native-arrival-export',
    readOnly: true,
  },
)
const makeRuntime = () =>
  ManagedRuntime.make(
    PostgresClientLive(
      { postgres, operationTimeoutMs: 5_000 },
      {
        maxConnections: 1,
        applicationName: 'bayn-export-observer',
      },
    ).pipe(Layer.provideMerge(NodeServices.layer)),
  )

describePostgres('read-only native prefix command lifecycle', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('Native export integration requires a local _test database')
    runtime = makeRuntime()
  })
  beforeEach(async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* nativeArrivalArchiveMigrations
      }),
    ),
  )
  afterAll(async () => runtime?.dispose())

  test('the archive reader overrides a writable URL and recovers from a rejected write without an open transaction', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        expect(yield* sql`SHOW transaction_read_only`).toEqual([{ transaction_read_only: 'on' }])
        const attempted = yield* sql`CREATE TABLE forbidden_export_write(value integer)`.pipe(Effect.result)
        expect(Result.isFailure(attempted)).toBe(true)
        if (Result.isFailure(attempted))
          expect(
            Schema.is(
              Schema.Struct({ reason: Schema.Struct({ cause: Schema.Struct({ code: Schema.Literal('25006') }) }) }),
            )(attempted.failure),
          ).toBe(true)
        expect(yield* sql`SELECT 1 AS alive`).toEqual([{ alive: 1 }])
      }).pipe(Effect.provide(reader)),
    )
  })

  test('whole-file verification and receipt publication run after every archive connection is released', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const observer = yield* PgClient.PgClient
        const fs = yield* FileSystem.FileSystem
        const data = nativeArrivalExportFixture()
        const store = makeNativeArrivalStore(observer)
        yield* store.begin(data.epoch)
        yield* store.append(data.chunks)
        const root = yield* fs.makeTempDirectoryScoped()
        const outputPath = `${root}/export`
        let validations = 0
        const noArchiveConnections = Effect.gen(function* () {
          const rows = yield* observer`SELECT count(*)::text AS count FROM pg_stat_activity
          WHERE datname=current_database() AND application_name='bayn-native-arrival-export'`
          if (!Schema.is(Schema.Tuple([Schema.Struct({ count: Schema.Literal('0') })]))(rows))
            return yield* Effect.fail('Archive connection is still held during local verification')
        }).pipe(Effect.retry({ times: 5, schedule: Schedule.spaced('10 millis') }), Effect.orDie)
        yield* runNativeArrivalExportCommand([
          '--capture-id',
          data.epoch.captureId,
          '--through-ordinal',
          '1',
          '--output',
          outputPath,
        ]).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              BAYN_NATIVE_ARRIVAL_POSTGRES_URL: testUrl,
              BAYN_POSTGRES_TLS: 'false',
            }),
          ),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            makeTempFileScoped: (options) =>
              Effect.gen(function* () {
                yield* noArchiveConnections
                expect(yield* fs.exists(`${outputPath}/source-receipt.json`)).toBe(false)
                validations++
                return yield* fs.makeTempFileScoped(options)
              }),
          }),
        )
        expect(validations).toBe(1)
        expect(yield* fs.exists(`${outputPath}/source-receipt.json`)).toBe(true)
        yield* noArchiveConnections
      }).pipe(Effect.scoped),
    )
  })
})
