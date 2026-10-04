import { afterAll, describe, expect, test } from 'bun:test'

import { NodeHttpClient } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Layer, ManagedRuntime, Result } from 'effect'

import { baynTestClickhouseGuardToken, baynTestClickhouseUrl } from '../test-environment.test-support'
import type { IntradaySnapshotRequest } from './intraday/model'
import { makeIntradayMarketDataQueries } from './intraday/queries'
import { decodeIntradayBarRows } from './intraday/rows'
import { intradayInstantNanos } from './intraday/time'
import { normalizeBar } from './intraday/verification'

const describeNative = baynTestClickhouseUrl === undefined ? describe.skip : describe
const sourceTopic = 'archive-precision-bars'
const request: IntradaySnapshotRequest = {
  calendar: {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    requestedRange: { start: '2026-10-01', end: '2026-10-01' },
    timeZone: 'UTC',
    sessions: [{ date: '2026-10-01', openAt: '2026-10-01T13:30:00.000Z', closeAt: '2026-10-01T20:00:00.000Z' }],
    normalizedResponseHash: 'b'.repeat(64),
  },
  universeId: 'archive-precision-v1',
  universeSymbolHash: 'a'.repeat(64),
  universe: ['SPY'],
  feed: 'sip',
  delayClass: 'real_time_consolidated',
  sessionDate: '2026-10-01',
  rangeStartAt: '2026-10-01T13:30:00.000Z',
  rangeEndAt: '2026-10-01T13:40:00.000Z',
  observedAt: '2026-10-01T14:00:00.000Z',
  maximumQuoteAgeMs: 5_000,
  minimumWatermarkLagMs: 1_000,
  sourceTopics: { bars: sourceTopic, quotes: 'unused-quotes', trades: 'unused-trades' },
  archiveWatermarks: [{ sourceTopic, sourcePartition: 0, inclusiveLastOffset: '9' }],
}

const bits = (value: number | null): string | null => {
  if (value === null) return null
  const bytes = new DataView(new ArrayBuffer(8))
  bytes.setFloat64(0, value)
  return bytes.getBigUint64(0).toString(16)
}

describeNative('production JDBC to Bayn archive identity', () => {
  const runtime = ManagedRuntime.make(
    ClickhouseClient.layer({
      url: baynTestClickhouseUrl ?? 'http://127.0.0.1:8123',
      username: 'default',
      password: '',
      database: 'default',
      application: 'bayn-archive-jdbc-readback-test',
      request_timeout: 5_000,
    }).pipe(Layer.provide(NodeHttpClient.layerNodeHttp)),
  )
  let guarded = false
  afterAll(async () => {
    if (guarded) {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* ClickhouseClient.ClickhouseClient
          yield* sql.asCommand(sql`DROP TABLE signal.intraday_bars_1m_v2`)
        }),
      )
    }
    await runtime.dispose()
  })

  test('reproduces exact timestamps and all numeric bits written by the production JDBC statement', async () => {
    if (baynTestClickhouseGuardToken === undefined || !/^[0-9a-f]{32}$/.test(baynTestClickhouseGuardToken)) {
      throw new Error('The JDBC readback requires the guarded disposable ClickHouse service')
    }
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* ClickhouseClient.ClickhouseClient
        const guard = yield* sql`SELECT toString(token) AS token FROM bayn_ci_guard.endpoint_identity`
        if (guard.length !== 1 || guard[0]?.['token'] !== baynTestClickhouseGuardToken) {
          throw new Error('The JDBC readback endpoint does not match the disposable ClickHouse guard')
        }
        guarded = true
        return yield* makeIntradayMarketDataQueries(sql).loadIntradayBars(request)
      }),
    )
    const bars = Result.getOrThrow(decodeIntradayBarRows(rows)).map((row) => Result.getOrThrow(normalizeBar(row)))
    expect(bars.map((bar) => [bar.open, bar.high, bar.low, bar.close, bar.volume, bar.vwap].map(bits))).toEqual([
      [248.51, 248.605, 248.44, 248.44, 1311, 248.518186].map(bits),
      [346.45, 346.55, 346.39, 346.44, 3562, 346.47072].map(bits),
      Array(6).fill('1'),
      Array(6).fill('7fefffffffffffff'),
      ['3ff0000000000000', '3ff0000000000000', '3ff0000000000000', '3ff0000000000000', '0', '3ff0000000000000'],
      [
        '3ff0000000000000',
        '3ff0000000000000',
        '3ff0000000000000',
        '3ff0000000000000',
        '8000000000000000',
        '3ff0000000000000',
      ],
      [
        '3fefffffffffffff',
        '3ff0000000000001',
        '3fefffffffffffff',
        '3ff0000000000000',
        '10000000000000',
        '3ff0000000000001',
      ],
      ['3ff0000000000000', '3ff0000000000000', '3ff0000000000000', '3ff0000000000000', '3ff0000000000000', null],
    ])
    const fractions = [0n, 1n, 999_999n, 1_000_000n, 321_780_322n, 999_999_999n, 0n, 1n]
    expect(bars.map((bar) => intradayInstantNanos(bar.eventAt))).toEqual(
      fractions.map((fraction, index) => 1_790_861_400_000_000_000n + BigInt(index) * 60_000_000_000n + fraction),
    )
    expect(bars.map((bar) => intradayInstantNanos(bar.ingestedAt))).toEqual(
      fractions.map((fraction, index) => 1_790_861_460_000_000_000n + BigInt(index) * 60_000_000_000n + fraction),
    )
    expect(bars.map((bar) => bar.sourceOffset)).toEqual(['2', '3', '4', '5', '6', '7', '8', '9'])
  })
})
