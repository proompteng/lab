import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { sha256 } from '../../hash'
import { streamingFixture, streamingFixtureFromRaw } from '../../testing/streaming-market-fixture'
import { IntradayCandidateEvidencePolicy, type IntradaySnapshotQuery } from '../intraday/model'
import { persistIntradayRecordRows } from '../intraday/verification'
import type { KafkaProjectionCut } from './kafka'
import { incorporateMarketRecord } from './projection'
import { compactStreamingProjection } from './query-cut'
import { constructStreamingSnapshot } from './snapshot'
import { emptyWebullProjection } from './webull-projection'

const equivalent = (cut: KafkaProjectionCut, query: IntradaySnapshotQuery) => {
  const expected = constructStreamingSnapshot(cut, query)
  const compact = compactStreamingProjection(cut, query)
  const actual = Result.flatMap(compact, (projection) => constructStreamingSnapshot({ ...cut, projection }, query))
  if (Result.isFailure(expected)) {
    if (Result.isSuccess(actual)) throw new Error('Compaction accepted a rejected source cut')
    expect(actual.failure).toMatchObject({ reason: expected.failure.reason, message: expected.failure.message })
    expect(actual.failure.facts).toEqual(expected.failure.facts)
  } else {
    if (Result.isFailure(actual)) throw actual.failure
    expect(actual.success).toEqual(expected.success)
    expect(persistIntradayRecordRows(actual.success)).toEqual(persistIntradayRecordRows(expected.success))
  }
  return compact
}

test('query compaction preserves snapshot bytes with histories at their existing entry caps', () => {
  const fixture = streamingFixture()
  const fill = <A>(histories: ReadonlyMap<string, readonly A[]>, size: number, latest = false) =>
    new Map(
      [...histories].map(([symbol, entries]) => [
        symbol,
        Array.from({ length: size }, (_, index) =>
          structuredClone(entries[latest ? entries.length - 1 : index % entries.length]),
        ),
      ]),
    )
  const source = fixture.cut.projection
  const cut = {
    ...fixture.cut,
    projection: {
      ...source,
      bars: fill(source.bars, 244),
      features: fill(source.features, 64),
      technicalFeatures: fill(source.technicalFeatures, 64),
      quoteHistory: fill(source.quoteHistory, 512, true),
      tradeHistory: fill(source.tradeHistory, 512, true),
    },
  }
  const compact = Result.getOrThrow(equivalent(cut, fixture.query))
  expect([...compact.quoteHistory.values()].every((entries) => entries.length === 1)).toBe(true)
  expect([...compact.tradeHistory.values()].every((entries) => entries.length === 1)).toBe(true)
  expect([...compact.features.values()].every((entries) => entries.length === 1)).toBe(true)
  expect([...compact.technicalFeatures.values()].every((entries) => entries.length === 1)).toBe(true)
  expect(compact.sequence).toBe(source.sequence)
  expect(compact.minimumObservationMs).toBe(source.minimumObservationMs)
})

test('compaction retains candidate exclusions and rejected, incomplete or unobserved cut failures', () => {
  const fixture = streamingFixture()
  const query = { ...fixture.query, candidateEvidencePolicy: IntradayCandidateEvidencePolicy.MarketQuotesV2 }
  const withdrawn = streamingFixtureFromRaw(
    {
      ...fixture.archive,
      quotes: fixture.archive.quotes.map((quote) =>
        quote.symbol === 'AAPL' ? { ...quote, askPrice: 0, askSize: 0 } : quote,
      ),
    },
    query,
  )
  equivalent(withdrawn.cut, query)
  equivalent({ ...fixture.cut, positions: [] }, fixture.query)
  equivalent(
    { ...fixture.cut, projection: { ...fixture.cut.projection, availabilityMode: 'simulated' } },
    fixture.query,
  )
  equivalent(fixture.cut, {
    ...fixture.query,
    observedAt: new Date(fixture.cut.bootstrap.observedAtMs - 1).toISOString(),
  })
  equivalent(
    {
      ...fixture.cut,
      projection: {
        ...fixture.cut.projection,
        rejections: new Map([
          [
            `${fixture.query.sourceTopics.quotes}:0`,
            [{ availableAtMs: Date.parse(fixture.query.observedAt) - 1, offset: '999', reason: 'malformed-source' }],
          ],
        ]),
      },
    },
    fixture.query,
  )
})

test('compaction retains native Webull capture bytes and first availability alongside the primary source', () => {
  const fixture = streamingFixture()
  const source = fixture.cut.projection.sources.get(fixture.query.universeId)
  if (source === undefined) throw new Error('Fixture source is required')
  const topic = 'webull'
  const universe = { ...source, topics: { ...source.topics, webullBars: topic } }
  const end = Date.parse(fixture.query.rangeEndAt)
  const payload = Buffer.from(
    JSON.stringify({
      result: [
        {
          symbol: 'AAPL',
          delay_minutes: '0',
          result: [
            {
              time: new Date(end - 60_000).toISOString().replace('Z', '+0000'),
              trading_session: 'RTH',
              open: '100',
              high: '102',
              low: '99',
              close: '101.000000000000000001',
              volume: '25000',
            },
          ],
        },
      ],
    }),
  )
  const value = JSON.stringify({
    version: 1,
    provider: 'webull',
    feed: 'nasdaq_basic',
    captureId: '96d77600-414a-4211-9342-f3a986254fbc',
    receivedAt: new Date(end).toISOString(),
    source: {
      type: 'http',
      endpoint: '/market-data/stocks/bars/list',
      requestedSymbols: ['AAPL'],
      requestBody: JSON.stringify({
        symbols: ['AAPL'],
        category: 'US_STOCK',
        timespan: 'M1',
        count: '5',
        real_time_required: true,
        trading_sessions: 'PRE,RTH,ATH',
        start_time: end - 300_000,
        end_time: end - 1,
      }),
    },
    payloadBase64: payload.toString('base64'),
    payloadSha256: sha256(payload),
  })
  const projection = incorporateMarketRecord(
    { ...fixture.cut.projection, webull: emptyWebullProjection(topic) },
    { topic, partition: 0, offset: '0', timestampMs: end, value },
    universe,
    end + 1,
  )
  const retained = projection.webull.bars.get('AAPL')
  if (retained === undefined) throw new Error('Webull fixture bar is required')
  const cut = {
    ...fixture.cut,
    projection: {
      ...projection,
      webull: {
        ...projection.webull,
        bars: new Map([['AAPL', Array.from({ length: 64 }, () => structuredClone(retained[0]!))]]),
      },
    },
    bootstrap: {
      ...fixture.cut.bootstrap,
      partitions: [
        ...fixture.cut.bootstrap.partitions,
        { topic, partition: 0, logStartOffset: '0', startOffset: '0', endOffset: '1' },
      ],
    },
    positions: [...fixture.cut.positions, { topic, partition: 0, offset: '1' }],
  }
  const compact = Result.getOrThrow(equivalent(cut, fixture.query))
  expect(compact.webull.bars.get('AAPL')).toHaveLength(1)
  const bar = compact.webull.bars.get('AAPL')?.[0]
  expect(bar?.delivery.record.value).toBe(value)
  expect(bar?.delivery.availableAtMs).toBe(end + 1)
})
