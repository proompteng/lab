import { describe, expect, test } from 'bun:test'

import type { ClickhouseClient } from '@effect/sql-clickhouse'

import type { IntradaySnapshotRequest } from './model'
import { intradayArchivePageSize, makeIntradayMarketDataQueries } from './queries'

const request: IntradaySnapshotRequest = {
  universeId: 'opening-drive-v1',
  universeSymbolHash: 'a'.repeat(64),
  universe: ['AMD'],
  feed: 'sip',
  delayClass: 'real_time_consolidated',
  sessionDate: '2026-08-18',
  rangeStartAt: '2026-08-18T13:30:00.000Z',
  rangeEndAt: '2026-08-18T14:00:00.000Z',
  observedAt: '2026-08-18T14:15:00.000Z',
  maximumQuoteAgeMs: 5_000,
  minimumWatermarkLagMs: 1_000,
  sourceTopics: {
    bars: 'bars',
    quotes: 'quotes',
    trades: 'trades',
  },
  archiveWatermarks: [
    { sourceTopic: 'bars', sourcePartition: 0, inclusiveLastOffset: '10' },
    { sourceTopic: 'quotes', sourcePartition: 0, inclusiveLastOffset: '11' },
    { sourceTopic: 'trades', sourcePartition: 0, inclusiveLastOffset: '12' },
  ],
}

const makeSqlRecorder = (): ClickhouseClient.ClickhouseClient => {
  const tag = (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) =>
    strings.reduce((query, part, index) => query + part + (index < values.length ? String(values[index]) : ''), '')
  return Object.assign(tag, {
    param: (_type: string, value: unknown) => JSON.stringify(value),
  }) as unknown as ClickhouseClient.ClickhouseClient
}

describe('intraday archive queries', () => {
  test('reads immutable intraday rows inside the declared range and observed ingestion bound', () => {
    const queries = makeIntradayMarketDataQueries(makeSqlRecorder())
    const capture = String(queries.captureIntradayArchiveWatermarks(request))
    const bars = String(queries.loadIntradayBars(request))
    const quotes = String(queries.loadIntradayQuotes(request))
    const trades = String(queries.loadIntradayTrades(request))

    expect(capture).toContain('FROM signal.intraday_bars_1m_v2')
    expect(bars).toContain('FROM signal.intraday_bars_1m_v2')
    expect(bars).toContain(`event_ts >= parseDateTime64BestEffort("${request.rangeStartAt}", 9, 'UTC')`)
    expect(bars).toContain(`event_ts < parseDateTime64BestEffort("${request.rangeEndAt}", 9, 'UTC')`)
    expect(bars).toContain(`ingest_ts <= parseDateTime64BestEffort("${request.observedAt}", 9, 'UTC')`)
    expect(bars).toContain('ORDER BY ingest_ts DESC, source_partition DESC, source_offset DESC')
    expect(bars).not.toContain('ORDER BY source_offset DESC\n')
    for (const query of [quotes, trades]) {
      expect(query).toContain(`event_ts >= parseDateTime64BestEffort("${request.rangeStartAt}", 9, 'UTC')`)
      expect(query).toContain(`event_ts <= parseDateTime64BestEffort("${request.observedAt}", 9, 'UTC')`)
      expect(query).not.toContain(`event_ts < parseDateTime64BestEffort("${request.rangeEndAt}", 9, 'UTC')`)
      expect(query).toContain(`ingest_ts <= parseDateTime64BestEffort("${request.observedAt}", 9, 'UTC')`)
    }
    for (const query of [bars, quotes, trades]) {
      expect(query).toContain(`LIMIT ${intradayArchivePageSize}`)
    }
  })

  test('preserves sub-millisecond bar request boundaries', () => {
    const queries = makeIntradayMarketDataQueries(makeSqlRecorder())
    const preciseRequest = {
      ...request,
      rangeStartAt: '2026-08-18T13:30:00.000000001Z',
      rangeEndAt: '2026-08-18T14:00:00.000000002Z',
      observedAt: '2026-08-18T14:15:00.000000003Z',
    }
    const bars = String(queries.loadIntradayBars(preciseRequest))

    expect(bars).toContain(`event_ts >= parseDateTime64BestEffort("${preciseRequest.rangeStartAt}", 9, 'UTC')`)
    expect(bars).toContain(`event_ts < parseDateTime64BestEffort("${preciseRequest.rangeEndAt}", 9, 'UTC')`)
    expect(bars).toContain(`ingest_ts <= parseDateTime64BestEffort("${preciseRequest.observedAt}", 9, 'UTC')`)
  })

  test('continues bounded pages strictly after the last canonical source identity', () => {
    const queries = makeIntradayMarketDataQueries(makeSqlRecorder())
    const cursor = {
      eventAt: '2026-08-18T13:45:01.123456789Z',
      symbol: 'AMD',
      sourceTopic: 'trades',
      sourcePartition: 2,
      sourceOffset: '42',
    }

    const bars = String(queries.loadIntradayBars(request, cursor))
    const quotes = String(queries.loadIntradayQuotes(request, cursor))
    const trades = String(queries.loadIntradayTrades(request, cursor))

    expect(bars).toContain(
      `WHERE tuple(event_ts, symbol, source_topic, toUInt64(source_partition), source_offset) > tuple(parseDateTime64BestEffort("${cursor.eventAt}", 3, 'UTC')`,
    )
    for (const query of [quotes, trades]) {
      expect(query).toContain(
        `AND tuple(event_ts, symbol, source_topic, toUInt64(source_partition), source_offset) > tuple(`,
      )
      expect(query).toContain(`parseDateTime64BestEffort("${cursor.eventAt}", 9, 'UTC')`)
      expect(query).toContain(`toUInt64("${cursor.sourcePartition}")`)
      expect(query).toContain(`toUInt64("${cursor.sourceOffset}")`)
    }
  })
})
