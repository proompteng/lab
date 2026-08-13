import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { NodeHttpClient } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Result } from 'effect'
import { SqlError } from 'effect/unstable/sql/SqlError'

import { config } from './app-test-support'
import { makeMarketDataQueries } from './market-data/queries'
import { baynTestClickhouseUrl, validateBaynTestClickhouseUrl } from './test-environment.test-support'
import { fixtureProtocol } from './test-fixtures'

const clickhouseUrl = baynTestClickhouseUrl
const describeClickhouse = clickhouseUrl === undefined ? describe.skip : describe
const publicationDate = '2026-03-06'
const calendarVersion = 'signal-XNYS-2026-v1'
const snapshotId = '1'.repeat(64)
let ownsSignalDatabase = false

const runtime = ManagedRuntime.make(
  ClickhouseClient.layer({
    url: clickhouseUrl ?? 'http://127.0.0.1:8123',
    username: 'default',
    password: '',
    database: 'default',
    application: 'bayn-market-data-integration-test',
    request_timeout: 5_000,
  }).pipe(Layer.provide(NodeHttpClient.layerNodeHttp)),
)

describe('Bayn ClickHouse integration target guard', () => {
  test('accepts only loopback HTTP(S) ClickHouse targets', () => {
    for (const value of ['http://127.0.0.1:8123', 'http://localhost:8123', 'http://[::1]:8123']) {
      expect(Result.isSuccess(validateBaynTestClickhouseUrl(value))).toBe(true)
    }
  })

  test('rejects shared, malformed, and non-HTTP ClickHouse targets before fixture DDL', () => {
    for (const value of ['https://clickhouse.example.test:8443', 'clickhouse://127.0.0.1:9000', 'not-a-url']) {
      expect(Result.isFailure(validateBaynTestClickhouseUrl(value))).toBe(true)
    }
  })
})

describeClickhouse('Bayn ClickHouse market-data query contract', () => {
  beforeAll(async () => {
    if (clickhouseUrl === undefined) return
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* Effect.fromResult(validateBaynTestClickhouseUrl(clickhouseUrl))
        const sql = yield* ClickhouseClient.ClickhouseClient
        yield* sql.asCommand(sql`CREATE DATABASE signal`)
        yield* Effect.sync(() => {
          ownsSignalDatabase = true
        })
        yield* sql.asCommand(sql`
          CREATE TABLE signal.snapshot_manifests_v2
          (
            snapshot_id String,
            schema_version LowCardinality(String),
            publisher_source_revision FixedString(40),
            publisher_image_repository String,
            publisher_image_digest FixedString(71),
            universe_id LowCardinality(String),
            universe_symbol_hash FixedString(64),
            provider LowCardinality(String),
            source_feed LowCardinality(String),
            adjustment LowCardinality(String),
            calendar_version LowCardinality(String),
            requested_start Date,
            publication_asof Date,
            first_session Date,
            last_session Date,
            symbol_count UInt32,
            session_count UInt32,
            bar_count UInt64,
            bars_content_hash FixedString(64),
            sessions_content_hash FixedString(64),
            manifest_content_hash FixedString(64),
            finalized_at DateTime64(3, 'UTC')
          )
          ENGINE = Memory
        `)
        yield* sql.insertQuery({
          table: 'signal.snapshot_manifests_v2',
          values: [
            {
              snapshot_id: snapshotId,
              schema_version: 'signal.snapshot-manifest.v2',
              publisher_source_revision: '2'.repeat(40),
              publisher_image_repository: 'registry.example.test/lab/signal-publisher',
              publisher_image_digest: `sha256:${'3'.repeat(64)}`,
              universe_id: fixtureProtocol.universeId,
              universe_symbol_hash: fixtureProtocol.universeSymbolHash,
              provider: 'alpaca',
              source_feed: 'sip',
              adjustment: 'all',
              calendar_version: calendarVersion,
              requested_start: fixtureProtocol.historyStart,
              publication_asof: publicationDate,
              first_session: fixtureProtocol.historyStart,
              last_session: publicationDate,
              symbol_count: fixtureProtocol.universe.length,
              session_count: 1,
              bar_count: fixtureProtocol.universe.length,
              bars_content_hash: '4'.repeat(64),
              sessions_content_hash: '5'.repeat(64),
              manifest_content_hash: '6'.repeat(64),
              finalized_at: `${publicationDate} 21:00:00.000`,
            },
          ],
        })
      }),
    )
  })

  afterAll(async () => {
    if (ownsSignalDatabase) {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* ClickhouseClient.ClickhouseClient
          yield* sql.asCommand(sql`DROP DATABASE signal`)
        }),
      )
    }
    await runtime.dispose()
  })

  test('reproduces the unqualified Date alias type failure that motivated PR 13347', async () => {
    const exit = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* ClickhouseClient.ClickhouseClient
        return yield* Effect.exit(sql`
          SELECT toString(requested_start) AS requested_start
          FROM signal.snapshot_manifests_v2
          WHERE requested_start = toDate(${sql.param('String', fixtureProtocol.historyStart)})
        `)
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const rendered = Cause.pretty(exit.cause)
      expect(rendered).toMatch(/String.*Date|Date.*String/)
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(SqlError)
        if (failure.value instanceof SqlError) {
          expect(failure.value.reason.cause).toMatchObject({ code: '386', type: 'NO_COMMON_TYPE' })
        }
      }
    }
  })

  test('executes the qualified production cycle-publication query against native Date columns', async () => {
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* ClickhouseClient.ClickhouseClient
        return yield* makeMarketDataQueries(sql, { clickhouse: config.clickhouse }, fixtureProtocol)
          .loadCyclePublicationManifests
      }),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      snapshot_id: snapshotId,
      universe_id: fixtureProtocol.universeId,
      universe_symbol_hash: fixtureProtocol.universeSymbolHash,
      requested_start: fixtureProtocol.historyStart,
      publication_asof: publicationDate,
      calendar_version: calendarVersion,
    })
  })
})
