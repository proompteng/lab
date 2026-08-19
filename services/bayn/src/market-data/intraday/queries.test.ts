import { describe, expect, test } from 'bun:test'

import type { ClickhouseClient } from '@effect/sql-clickhouse'

import type { IntradaySnapshotRequest } from './model'
import { makeIntradayMarketDataQueries } from './queries'

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
    expect(bars).toContain(`event_ts < parseDateTime64BestEffort("${request.rangeEndAt}", 3, 'UTC')`)
    for (const query of [quotes, trades]) {
      expect(query).toContain(`event_ts >= parseDateTime64BestEffort("${request.rangeStartAt}", 9, 'UTC')`)
      expect(query).toContain(`event_ts < parseDateTime64BestEffort("${request.rangeEndAt}", 9, 'UTC')`)
      expect(query).toContain(`ingest_ts <= parseDateTime64BestEffort("${request.observedAt}", 9, 'UTC')`)
    }
  })
})
