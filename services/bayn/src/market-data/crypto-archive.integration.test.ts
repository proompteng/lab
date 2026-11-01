import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NodeHttpClient } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'

import { cryptoMarketProfile } from '../jev/markets'
import { cryptoMarketFixture } from '../testing/crypto-market-fixture'
import { baynTestClickhouseGuardToken, baynTestClickhouseUrl } from '../test-environment.test-support'
import { MarketVolumeBindingRow } from '../forward-performance/postgres/model'
import { marketVolumeRequestsFromRows } from '../forward-performance/postgres/projection'
import { readForwardPerformanceMarketVolumeWithClient } from '../forward-performance/program'
import {
  intradayPerformanceDecisionRequest,
  intradayPerformanceSessionQuery,
} from '../forward-performance/intraday-volume'
import { makeIntradayMarketDataQueries } from './intraday/queries'
import { decodeIntradayQuoteRows, decodeIntradayTradeRows } from './intraday/rows'
import { verifyIntradayArchiveWatermarks } from './intraday/verification'

const describeNative = baynTestClickhouseUrl === undefined ? describe.skip : describe
const symbols = ['BTC/USD', 'ETH/USD', 'SOL/USD'] as const
const runtime = ManagedRuntime.make(
  ClickhouseClient.layer({
    url: baynTestClickhouseUrl ?? 'http://127.0.0.1:8123',
    username: 'default',
    password: '',
    database: 'default',
    application: 'bayn-crypto-archive-test',
    request_timeout: 5_000,
  }).pipe(Layer.provide(NodeHttpClient.layerNodeHttp)),
)
let guarded = false

const reportRequest = (symbol: 'BTC/USD' | 'ETH/USD' | 'SOL/USD') => {
  const manifest = cryptoMarketFixture(symbol).snapshot.manifest
  const end = Date.parse(manifest.rangeEndAt)
  const binding = Schema.decodeUnknownSync(MarketVolumeBindingRow)({
    cycle_id: 'a'.repeat(64),
    snapshot_id: manifest.snapshotId,
    execution_session_date: manifest.sessionDate,
    execution_open_at: new Date(end + 500),
    execution_close_at: new Date(end + 192_000),
    manifest,
  })
  const request = marketVolumeRequestsFromRows(
    [{ cycleId: binding.cycle_id, symbol }],
    [binding],
    new Date(end + 200_000).toISOString(),
  )[0]
  if (request === undefined || !('decisionManifest' in request)) throw new Error('Missing crypto request')
  return request
}

describeNative('native crypto archive reporting', () => {
  beforeAll(async () => {
    if (baynTestClickhouseGuardToken === undefined || !/^[0-9a-f]{32}$/.test(baynTestClickhouseGuardToken))
      throw new Error('Crypto archive tests require the guarded disposable ClickHouse service')
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* ClickhouseClient.ClickhouseClient
        const guard = yield* sql`SELECT toString(token) AS token FROM bayn_ci_guard.endpoint_identity`
        if (guard.length !== 1 || guard[0]?.['token'] !== baynTestClickhouseGuardToken)
          throw new Error('Crypto archive endpoint does not match its disposable guard')
        guarded = true
        yield* sql.asCommand(sql`CREATE DATABASE IF NOT EXISTS signal`)
        yield* sql.asCommand(sql`DROP TABLE IF EXISTS signal.crypto_market_events_v1`)
        yield* sql.asCommand(sql`CREATE TABLE signal.crypto_market_events_v1 (
          provider String, location String, channel String, symbol String,
          event_ts DateTime64(9,'UTC'), ingest_ts DateTime64(9,'UTC'),
          source_topic String, source_partition UInt32, source_offset UInt64,
          sequence UInt64, payload String, schema_version UInt16
        ) ENGINE=ReplacingMergeTree ORDER BY (location,symbol,event_ts,source_topic,source_partition,source_offset)`)
        for (const [partition, symbol] of symbols.entries()) {
          const request = reportRequest(symbol)
          const end = Date.parse(request.decisionManifest.rangeEndAt)
          const insert = (channel: string, eventAt: string, ingestedAt: string, offset: number, payload: string) =>
            sql.asCommand(sql`INSERT INTO signal.crypto_market_events_v1 VALUES (
              'alpaca','us',${channel},${symbol},parseDateTime64BestEffort(${eventAt},9,'UTC'),
              parseDateTime64BestEffort(${ingestedAt},9,'UTC'),${cryptoMarketProfile.sourceTopics.bars},
              ${partition + 1},${offset},${offset},${payload},1)`)
          for (const minute of [1, 2]) {
            const eventAt = new Date(end + minute * 60_000).toISOString()
            const payload = `{"T":"b","S":"${symbol}","t":"${eventAt}","o":103.123456789,"h":103.123456789,"l":103.123456789,"c":103.123456789,"v":0.031234567}`
            yield* insert('bars', eventAt, new Date(end + (minute + 1) * 60_000).toISOString(), 1000 + minute, payload)
            const late = request.evidenceCutoffAt.replace('.000Z', '.000000001Z')
            yield* insert('updatedBars', eventAt, late, 2000 + minute, payload.replace('0.031234567', '999'))
          }
          const eventAt = new Date(end + 179_000).toISOString()
          yield* insert(
            'quotes',
            eventAt,
            eventAt,
            1003,
            `{"T":"q","S":"${symbol}","t":"${eventAt}","bp":103.123456789,"bs":0.000000001,"ap":103.123456799,"as":0.031234567}`,
          )
          yield* insert(
            'trades',
            eventAt,
            eventAt,
            1004,
            `{"T":"t","S":"${symbol}","t":"${eventAt}","p":103.123456789,"s":0.000000001,"i":9007199254740993,"tks":"B"}`,
          )
        }
      }),
    )
  })
  afterAll(async () => {
    if (guarded)
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* ClickhouseClient.ClickhouseClient
          yield* sql.asCommand(sql`DROP TABLE signal.crypto_market_events_v1`)
        }),
      )
    await runtime.dispose()
  })

  test.each([...symbols])(
    '%s runs the shared performance reader against producer storage with exact decimals and an ingestion cutoff',
    async (symbol) => {
      const request = reportRequest(symbol)
      const evidence = await runtime.runPromise(
        readForwardPerformanceMarketVolumeWithClient(
          {
            clickhouse: { url: baynTestClickhouseUrl ?? '', username: 'default', password: Redacted.make('') },
            operationTimeoutMs: 5_000,
          },
          [request],
        ),
      )
      expect(evidence).toHaveLength(1)
      expect(evidence[0]).toMatchObject({
        sourceFeed: 'us',
        quantityAtoms: '62469134',
        closePriceMicros: '103123457',
        barCount: 2,
      })
      const rows = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* ClickhouseClient.ClickhouseClient
          const queries = makeIntradayMarketDataQueries(sql)
          const original = Result.getOrThrow(intradayPerformanceDecisionRequest(request))
          const query = intradayPerformanceSessionQuery(request, original)
          const archiveWatermarks = Result.getOrThrow(
            verifyIntradayArchiveWatermarks(query, yield* queries.captureIntradayArchiveWatermarks(query)),
          )
          const archive = { ...query, archiveWatermarks }
          return {
            quotes: Result.getOrThrow(decodeIntradayQuoteRows(yield* queries.loadIntradayQuotes(archive))),
            trades: Result.getOrThrow(decodeIntradayTradeRows(yield* queries.loadIntradayTrades(archive))),
            empty: yield* queries.loadIntradayBars({ ...archive, universeSymbolHash: '0'.repeat(64) }),
          }
        }),
      )
      expect(rows.quotes[0]).toMatchObject({ symbol, bid_price: '103.123456789' })
      expect(Number(rows.quotes[0]?.bid_size)).toBe(0.000000001)
      expect(rows.trades[0]?.symbol).toBe(symbol)
      expect(Number(rows.trades[0]?.size)).toBe(0.000000001)
      expect(rows.trades[0]?.native_payload).toContain('9007199254740993')
      expect(rows.empty).toEqual([])
    },
  )
})
