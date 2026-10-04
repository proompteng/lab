import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { NodeHttpClient } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Cause, Effect, Exit, Layer, ManagedRuntime, Result } from 'effect'

import { persistedMarketDataContract } from './testing/persisted-snapshot-fixture'
import { historicalSignalConfig } from './testing/historical-signal-fixture'
import type { IntradaySnapshotQuery, IntradaySnapshotRequest } from './market-data/intraday/model'
import { intradayInstantNanos } from './market-data/intraday/time'
import { decodeIntradayBarRows } from './market-data/intraday/rows'
import { normalizeBar } from './market-data/intraday/verification'
import { makeIntradayMarketDataQueries } from './market-data/intraday/queries'
import { makeMarketDataQueries } from './market-data/queries'
import { baynTestClickhouseGuardToken, baynTestClickhouseUrl } from './test-environment.test-support'

const clickhouseUrl = baynTestClickhouseUrl
const describeClickhouse = clickhouseUrl === undefined ? describe.skip : describe
const publicationDate = '2026-03-06'
const calendarVersion = 'signal-XNYS-2026-v1'
const snapshotId = '1'.repeat(64)
const intradayRequest: IntradaySnapshotQuery = {
  calendar: {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    requestedRange: { start: publicationDate, end: publicationDate },
    timeZone: 'UTC',
    sessions: [
      {
        date: publicationDate,
        openAt: `${publicationDate}T13:30:00.000Z`,
        closeAt: `${publicationDate}T20:00:00.000Z`,
      },
    ],
    normalizedResponseHash: '7'.repeat(64),
  },
  universeId: 'bayn-clickhouse-integration',
  universeSymbolHash: '8'.repeat(64),
  universe: ['AMD'],
  feed: 'sip',
  delayClass: 'real_time_consolidated',
  sessionDate: publicationDate,
  rangeStartAt: `${publicationDate}T13:30:00.000Z`,
  rangeEndAt: `${publicationDate}T14:00:00.000Z`,
  observedAt: `${publicationDate}T14:15:00.000Z`,
  maximumQuoteAgeMs: 5_000,
  minimumWatermarkLagMs: 1_000,
  sourceTopics: { bars: 'bars', quotes: 'quotes', trades: 'trades' },
}
const clickhouseGuardTokenPattern = /^[0-9a-f]{32}$/
let destructiveFixtureArmed = false

const errorCauseChain = (root: unknown): ReadonlyArray<Record<string, unknown>> => {
  const chain: Array<Record<string, unknown>> = []
  const seen = new Set<object>()
  let current: unknown = root

  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current)
    const error = current as Record<string, unknown>
    chain.push(error)
    current = error['cause']
  }

  return chain
}

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

describeClickhouse('Bayn ClickHouse market-data query contract', () => {
  beforeAll(async () => {
    if (baynTestClickhouseGuardToken === undefined || !clickhouseGuardTokenPattern.test(baynTestClickhouseGuardToken)) {
      throw new Error(
        'BAYN_TEST_CLICKHOUSE_GUARD_TOKEN must identify the disposable ClickHouse service before destructive fixture setup',
      )
    }

    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* ClickhouseClient.ClickhouseClient
        const guardRows = yield* sql<{ readonly token: string }>`
          SELECT toString(token) AS token
          FROM bayn_ci_guard.endpoint_identity
        `
        if (guardRows.length !== 1 || guardRows[0]?.token !== baynTestClickhouseGuardToken) {
          throw new Error('BAYN_TEST_CLICKHOUSE_URL does not resolve to the guarded disposable ClickHouse service')
        }

        destructiveFixtureArmed = true
        yield* sql.asCommand(sql`CREATE DATABASE IF NOT EXISTS signal`)
        yield* sql.asCommand(sql`DROP TABLE IF EXISTS signal.intraday_bars_1m_v2`)
        yield* sql.asCommand(sql`DROP TABLE IF EXISTS signal.intraday_quotes_v1`)
        yield* sql.asCommand(sql`DROP TABLE IF EXISTS signal.intraday_trades_v1`)
        yield* sql.asCommand(sql`
          CREATE TABLE signal.intraday_bars_1m_v2
          (
            provider String DEFAULT 'alpaca',
            universe_id String,
            universe_symbol_hash String,
            feed String,
            channel String DEFAULT 'bars',
            market_session String DEFAULT 'regular',
            delay_class String DEFAULT 'real_time_consolidated',
            symbol String DEFAULT 'AMD',
            source_topic String,
            source_partition UInt32,
            source_offset UInt64,
            event_ts DateTime64(3, 'UTC'),
            ingest_ts DateTime64(3, 'UTC'),
            is_final UInt8 DEFAULT 1,
            open Float64 DEFAULT 100,
            high Float64 DEFAULT 101,
            low Float64 DEFAULT 99,
            close Float64 DEFAULT 100,
            volume Float64 DEFAULT 10,
            vwap Nullable(Float64),
            trade_count Nullable(UInt64),
            schema_version UInt32 DEFAULT 1
          )
          ENGINE = ReplacingMergeTree(source_offset)
          PARTITION BY toYYYYMM(event_ts)
          ORDER BY (universe_id, feed, symbol, event_ts, source_topic, source_partition, source_offset)
        `)
        yield* sql.asCommand(sql`
          CREATE TABLE signal.intraday_quotes_v1
          (
            universe_id String,
            universe_symbol_hash String,
            feed String,
            source_topic String,
            source_partition UInt32,
            source_offset UInt64,
            event_ts DateTime64(9, 'UTC'),
            ingest_ts DateTime64(9, 'UTC')
          )
          ENGINE = Memory
        `)
        yield* sql.asCommand(sql`
          CREATE TABLE signal.intraday_trades_v1
          (
            universe_id String,
            universe_symbol_hash String,
            feed String,
            source_topic String,
            source_partition UInt32,
            source_offset UInt64,
            event_ts DateTime64(9, 'UTC'),
            ingest_ts DateTime64(9, 'UTC')
          )
          ENGINE = Memory
        `)
        yield* sql.insertQuery({
          table: 'signal.intraday_bars_1m_v2',
          values: [
            {
              universe_id: intradayRequest.universeId,
              universe_symbol_hash: intradayRequest.universeSymbolHash,
              feed: intradayRequest.feed,
              source_topic: intradayRequest.sourceTopics.bars,
              source_partition: 2,
              source_offset: 20,
              event_ts: `${publicationDate} 13:45:00.000`,
              ingest_ts: `${publicationDate} 14:00:00.000`,
            },
            {
              universe_id: intradayRequest.universeId,
              universe_symbol_hash: intradayRequest.universeSymbolHash,
              feed: intradayRequest.feed,
              source_topic: intradayRequest.sourceTopics.bars,
              source_partition: 10,
              source_offset: 100,
              event_ts: `${publicationDate} 13:46:00.000`,
              ingest_ts: `${publicationDate} 14:01:00.000`,
            },
          ],
        })
        yield* sql.asCommand(sql`
          ALTER TABLE signal.intraday_bars_1m_v2
            ADD COLUMN IF NOT EXISTS event_ts_exact Nullable(DateTime64(9, 'UTC')),
            ADD COLUMN IF NOT EXISTS ingest_ts_exact Nullable(DateTime64(9, 'UTC'))
        `)
        yield* sql.asCommand(sql`DROP TABLE IF EXISTS signal.snapshot_manifests_v2`)
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
              universe_id: persistedMarketDataContract.universeId,
              universe_symbol_hash: persistedMarketDataContract.universeSymbolHash,
              provider: 'alpaca',
              source_feed: 'sip',
              adjustment: 'all',
              calendar_version: calendarVersion,
              requested_start: persistedMarketDataContract.historyStart,
              publication_asof: publicationDate,
              first_session: persistedMarketDataContract.historyStart,
              last_session: publicationDate,
              symbol_count: persistedMarketDataContract.universe.length,
              session_count: 1,
              bar_count: persistedMarketDataContract.universe.length,
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
    if (destructiveFixtureArmed) {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* ClickhouseClient.ClickhouseClient
          yield* sql.asCommand(sql`DROP TABLE IF EXISTS signal.intraday_bars_1m_v2`)
          yield* sql.asCommand(sql`DROP TABLE IF EXISTS signal.intraday_quotes_v1`)
          yield* sql.asCommand(sql`DROP TABLE IF EXISTS signal.intraday_trades_v1`)
          yield* sql.asCommand(sql`DROP TABLE IF EXISTS signal.snapshot_manifests_v2`)
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
          WHERE requested_start = toDate(${sql.param('String', persistedMarketDataContract.historyStart)})
        `)
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const clickhouseError = errorCauseChain(Cause.squash(exit.cause)).find(
        (error) => error['code'] === '386' && error['type'] === 'NO_COMMON_TYPE',
      )
      expect(clickhouseError).toBeDefined()
      expect(clickhouseError?.['message']).toMatch(/String.*Date|Date.*String/)
    }
  })

  test('executes the qualified production cycle-publication query against native Date columns', async () => {
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* ClickhouseClient.ClickhouseClient
        return yield* makeMarketDataQueries(
          sql,
          { historicalSignal: historicalSignalConfig },
          persistedMarketDataContract,
        ).loadCyclePublicationManifests
      }),
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      snapshot_id: snapshotId,
      universe_id: persistedMarketDataContract.universeId,
      universe_symbol_hash: persistedMarketDataContract.universeSymbolHash,
      requested_start: persistedMarketDataContract.historyStart,
      publication_asof: publicationDate,
      calendar_version: calendarVersion,
    })
  })

  test('captures numerically ordered partition watermarks with string wire fields', async () => {
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* ClickhouseClient.ClickhouseClient
        return yield* makeIntradayMarketDataQueries(sql).captureIntradayArchiveWatermarks(intradayRequest)
      }),
    )

    expect(rows).toEqual([
      { source_topic: 'bars', source_partition: '2', inclusive_last_offset: '20' },
      { source_topic: 'bars', source_partition: '10', inclusive_last_offset: '100' },
    ])
  })

  test('adds exact timestamps without rewriting legacy values or changing key precision', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* ClickhouseClient.ClickhouseClient
        const widening = yield* Effect.exit(
          sql.asCommand(sql`
          ALTER TABLE signal.intraday_bars_1m_v2 MODIFY COLUMN event_ts DateTime64(9, 'UTC')
        `),
        )
        yield* sql.asCommand(sql`
          ALTER TABLE signal.intraday_bars_1m_v2
            ADD COLUMN IF NOT EXISTS event_ts_exact Nullable(DateTime64(9, 'UTC')),
            ADD COLUMN IF NOT EXISTS ingest_ts_exact Nullable(DateTime64(9, 'UTC'))
        `)
        const legacy = yield* sql`
          SELECT toString(event_ts) AS event_at, toString(ingest_ts) AS ingested_at,
            event_ts_exact, ingest_ts_exact
          FROM signal.intraday_bars_1m_v2 WHERE source_topic = 'bars' ORDER BY source_partition
        `
        const mutations = yield* sql`
          SELECT toString(count()) AS count FROM system.mutations
          WHERE database = 'signal' AND table = 'intraday_bars_1m_v2'
        `
        return { widening, legacy, mutations }
      }),
    )
    expect(Exit.isFailure(result.widening)).toBe(true)
    if (Exit.isFailure(result.widening)) {
      expect(
        errorCauseChain(Cause.squash(result.widening.cause)).some(
          (error) => error['type'] === 'ALTER_OF_COLUMN_IS_FORBIDDEN',
        ),
      ).toBe(true)
    }
    expect(result.legacy).toEqual([
      {
        event_at: '2026-03-06 13:45:00.000',
        ingested_at: '2026-03-06 14:00:00.000',
        event_ts_exact: null,
        ingest_ts_exact: null,
      },
      {
        event_at: '2026-03-06 13:46:00.000',
        ingested_at: '2026-03-06 14:01:00.000',
        event_ts_exact: null,
        ingest_ts_exact: null,
      },
    ])
    expect(result.mutations).toEqual([{ count: '0' }])
  })

  test('preserves exact availability, revision order, duplicate identity, and mixed-precision cursors', async () => {
    const sourceTopic = 'bars-precision'
    const request: IntradaySnapshotRequest = {
      ...intradayRequest,
      sourceTopics: { ...intradayRequest.sourceTopics, bars: sourceTopic },
      observedAt: '2026-03-06T13:41:00.400000000Z',
      archiveWatermarks: [
        { sourceTopic, sourcePartition: 0, inclusiveLastOffset: '5' },
        { sourceTopic, sourcePartition: 1, inclusiveLastOffset: '1' },
      ],
    }
    const rows = [
      { event: '000', ingest: '321', offset: 1, partition: 0, exact: false },
      { event: '000000001', ingest: '321000001', offset: 2, partition: 0, exact: true },
      { event: '000000001', ingest: '321780322', offset: 3, partition: 0, exact: true },
      { event: '000000001', ingest: '321780322', offset: 3, partition: 0, exact: true },
      { event: '000000001', ingest: '321780322', offset: 1, partition: 1, exact: true },
      { event: '000999999', ingest: '321999999', offset: 4, partition: 0, exact: true },
      { event: '001000000', ingest: '322000000', offset: 5, partition: 0, exact: true },
    ]
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* ClickhouseClient.ClickhouseClient
        yield* sql.insertQuery({
          table: 'signal.intraday_bars_1m_v2',
          values: rows.map((row) => ({
            universe_id: request.universeId,
            universe_symbol_hash: request.universeSymbolHash,
            feed: request.feed,
            source_topic: sourceTopic,
            source_partition: row.partition,
            source_offset: row.offset,
            event_ts: `2026-03-06 13:40:00.${row.event.slice(0, 3)}`,
            ingest_ts: `2026-03-06 13:41:00.${row.ingest.slice(0, 3)}`,
            event_ts_exact: row.exact ? `2026-03-06 13:40:00.${row.event}` : null,
            ingest_ts_exact: row.exact ? `2026-03-06 13:41:00.${row.ingest}` : null,
          })),
          format: 'JSONEachRow',
        })
      }),
    )
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* ClickhouseClient.ClickhouseClient
        const queries = makeIntradayMarketDataQueries(sql)
        const all = yield* queries.loadIntradayBars(request)
        const atBoundary = yield* queries.loadIntradayBars({ ...request, observedAt: '2026-03-06T13:41:00.321780322Z' })
        const beforeBoundary = yield* queries.loadIntradayBars({
          ...request,
          observedAt: '2026-03-06T13:41:00.321780321Z',
        })
        const watermarks = yield* queries.captureIntradayArchiveWatermarks({
          ...request,
          observedAt: '2026-03-06T13:41:00.321780321Z',
        })
        const bounded = yield* queries.loadIntradayBars({
          ...request,
          rangeStartAt: '2026-03-06T13:40:00.000000001Z',
          rangeEndAt: '2026-03-06T13:40:00.001000000Z',
        })
        const after = yield* queries.loadIntradayBars(request, {
          eventAt: '2026-03-06T13:40:00.000999999Z',
          symbol: 'AMD',
          sourceTopic,
          sourcePartition: 0,
          sourceOffset: '4',
        })
        return { all, atBoundary, beforeBoundary, watermarks, bounded, after }
      }),
    )
    expect(
      result.all.map((row) => [row['event_at'], row['ingested_at'], row['source_partition'], row['source_offset']]),
    ).toEqual([
      ['2026-03-06T13:40:00.000Z', '2026-03-06T13:41:00.321Z', '0', '1'],
      ['2026-03-06T13:40:00.000000001Z', '2026-03-06T13:41:00.321780322Z', '1', '1'],
      ['2026-03-06T13:40:00.000999999Z', '2026-03-06T13:41:00.321999999Z', '0', '4'],
      ['2026-03-06T13:40:00.001000000Z', '2026-03-06T13:41:00.322000000Z', '0', '5'],
    ])
    expect(result.atBoundary.map((row) => row['ingested_at'])).toEqual([
      '2026-03-06T13:41:00.321Z',
      '2026-03-06T13:41:00.321780322Z',
    ])
    expect(result.beforeBoundary.map((row) => row['ingested_at'])).toEqual([
      '2026-03-06T13:41:00.321Z',
      '2026-03-06T13:41:00.321000001Z',
    ])
    expect(result.watermarks).toEqual([
      { source_topic: sourceTopic, source_partition: '0', inclusive_last_offset: '2' },
    ])
    expect(result.bounded.map((row) => row['event_at'])).toEqual([
      '2026-03-06T13:40:00.000000001Z',
      '2026-03-06T13:40:00.000999999Z',
    ])
    expect(result.after.map((row) => row['event_at'])).toEqual(['2026-03-06T13:40:00.001000000Z'])
    expect(intradayInstantNanos(String(result.atBoundary[1]?.['ingested_at']))).toBe(1772804460321780322n)
  })

  test('preserves adjacent binary64 VWAP values through the production archive reader', async () => {
    const sourceTopic = 'bars-binary64'
    const expectedBits = [0x406f1094face67d7n, 0x406f1094face67d8n, 0x4075a78811b1d92bn, 0x4075a78811b1d92cn]
    const request: IntradaySnapshotRequest = {
      ...intradayRequest,
      sourceTopics: { ...intradayRequest.sourceTopics, bars: sourceTopic },
      archiveWatermarks: [{ sourceTopic, sourcePartition: 0, inclusiveLastOffset: '4' }],
    }
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* ClickhouseClient.ClickhouseClient
        for (const [index, bits] of expectedBits.entries()) {
          yield* sql.asCommand(sql`
          INSERT INTO signal.intraday_bars_1m_v2
            (universe_id, universe_symbol_hash, feed, source_topic, source_partition, source_offset,
              event_ts, ingest_ts, event_ts_exact, ingest_ts_exact, vwap)
          VALUES (${sql.param('String', request.universeId)}, ${sql.param('String', request.universeSymbolHash)},
            'sip', ${sql.param('String', sourceTopic)}, 0, ${sql.param('UInt64', String(index + 1))},
            parseDateTime64BestEffort(${sql.param('String', `2026-03-06T13:4${index}:00.000Z`)}, 3, 'UTC'),
            '2026-03-06 13:45:00.321',
            parseDateTime64BestEffort(${sql.param('String', `2026-03-06T13:4${index}:00.000000000Z`)}, 9, 'UTC'),
            '2026-03-06 13:45:00.321780322', reinterpretAsFloat64(${sql.param('UInt64', String(bits))}))
        `)
        }
        return yield* makeIntradayMarketDataQueries(sql).loadIntradayBars(request)
      }),
    )
    const bars = Result.getOrThrow(decodeIntradayBarRows(rows)).map((row) => Result.getOrThrow(normalizeBar(row)))
    expect(
      bars.map((bar) => {
        const bytes = new DataView(new ArrayBuffer(8))
        bytes.setFloat64(0, Number(bar.vwap))
        return bytes.getBigUint64(0)
      }),
    ).toEqual(expectedBits)
  })
})
