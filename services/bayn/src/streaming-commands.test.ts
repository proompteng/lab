import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { canonicalJsonV1Result } from './hash'
import { emptyStreamingProjection } from './market-data/streaming/projection'
import {
  decodeStreamingDiagnosticQuery,
  parseStreamingDiagnosticsArgs,
  streamingInputDiagnosticReceipt,
  summarizeStreamingSymbol,
} from './streaming-diagnostics-command'
import { streamingFixture } from './testing/streaming-market-fixture'
import { defaultJevProtocolDocument } from './jev/protocol'
import { makeJevEntryQuery } from './jev/observation-query'
import { decodeTechnicalMarketFeature } from './market-data/features/technical-contract'
import technicalFixture from './market-data/features/fixtures/technical-indicators-v1.json'

test('streaming diagnostics require an explicit query file', () => {
  expect(parseStreamingDiagnosticsArgs(['--query', 'query.json']).kind).toBe('probe')
  expect(parseStreamingDiagnosticsArgs(['--query', '']).kind).toBe('invalid')
  expect(parseStreamingDiagnosticsArgs(['--since', '2026-09-11']).kind).toBe('invalid')
  expect(parseStreamingDiagnosticsArgs(['--help']).kind).toBe('help')
})

test('historical diagnostics require an explicit bounded bootstrap budget', () => {
  const args = ['--query', 'query.json']
  expect(parseStreamingDiagnosticsArgs(args)).toMatchObject({ kind: 'probe', bootstrapTimeoutMs: 300_000 })
  for (const seconds of ['1', '1800', '3600', '7200', '14400']) {
    expect(parseStreamingDiagnosticsArgs([...args, '--bootstrap-timeout-seconds', seconds])).toMatchObject({
      kind: 'probe',
      bootstrapTimeoutMs: Number(seconds) * 1000,
    })
  }
  for (const seconds of ['0', '-1', '14401', 'Infinity', 'NaN', '1.5', '1e3', ' 300', '']) {
    expect(parseStreamingDiagnosticsArgs([...args, '--bootstrap-timeout-seconds', seconds]).kind).toBe('invalid')
  }
  expect(parseStreamingDiagnosticsArgs([...args, '--bootstrap-timeout-seconds']).kind).toBe('invalid')
  expect(parseStreamingDiagnosticsArgs([...args, '--timeout', '3600']).kind).toBe('invalid')
  expect(parseStreamingDiagnosticsArgs(['--codecs', '--bootstrap-timeout-seconds', '3600']).kind).toBe('invalid')
})

test('streaming diagnostics serialize explicit missing coverage for a configured symbol', () => {
  const symbol = summarizeStreamingSymbol(emptyStreamingProjection('diagnostic-coverage'), 'AMD', 1000)
  const encoded = canonicalJsonV1Result({ symbols: [symbol] })
  expect(Result.isSuccess(encoded)).toBe(true)
  if (Result.isFailure(encoded)) return
  expect(JSON.parse(encoded.success)).toEqual({
    symbols: [
      {
        symbol: 'AMD',
        retainedBars: 0,
        retainedFeatures: 0,
        latestQuoteAt: null,
        latestTradeAt: null,
        matchedFeatures: [],
      },
    ],
  })
})

test('diagnostic queries validate temporal semantics and retain global unavailable candidate identities', () => {
  const fixture = streamingFixture()
  const query = makeJevEntryQuery({
    protocol: defaultJevProtocolDocument,
    calendar: fixture.query.calendar,
    sessionDate: fixture.query.sessionDate,
    observedAtMs: Date.parse(fixture.query.observedAt),
    candidates: fixture.query.candidateSymbols ?? [],
  })
  expect(Result.isSuccess(decodeStreamingDiagnosticQuery(query))).toBeTrue()
  expect(
    Result.isFailure(decodeStreamingDiagnosticQuery({ ...fixture.query, observedAt: fixture.query.rangeStartAt })),
  ).toBeTrue()
  const diagnostics = streamingInputDiagnosticReceipt(emptyStreamingProjection('diagnostic'), fixture.query)
  expect(diagnostics.status).toBe('UNAVAILABLE')
  expect(diagnostics.candidates.map(({ symbol }) => symbol)).toEqual([...(fixture.query.candidateSymbols ?? [])])
})

test('historical diagnostic counts and latest records exclude arrivals after the requested observation', () => {
  const { cut, query } = streamingFixture()
  const at = Date.parse(query.observedAt)
  const symbol = 'AAPL'
  const bars = cut.projection.bars.get(symbol) ?? []
  const features = cut.projection.features.get(symbol) ?? []
  const quotes = cut.projection.quoteHistory.get(symbol) ?? []
  const trades = cut.projection.tradeHistory.get(symbol) ?? []
  const bar = bars[0]
  const feature = features[0]
  const quote = quotes[0]
  const trade = trades[0]
  if (bar === undefined || feature === undefined || quote === undefined || trade === undefined)
    throw new Error('Missing native diagnostic fixture material')
  const technical = {
    value: Result.getOrThrow(decodeTechnicalMarketFeature(technicalFixture)),
    availableAtMs: at,
    sequence: cut.projection.sequence + 1,
    recordHash: 'a'.repeat(64),
    topic: 'technical',
    partition: 0,
    offset: '0',
  }
  const later = new Date(at + 1).toISOString()
  const projection = {
    ...cut.projection,
    technicalTopic: technical.topic,
    bars: new Map(cut.projection.bars).set(symbol, [...bars, { ...bar, availableAtMs: at + 1 }]),
    features: new Map(cut.projection.features).set(symbol, [...features, { ...feature, availableAtMs: at + 1 }]),
    technicalFeatures: new Map([
      [symbol, [technical, { ...technical, availableAtMs: at + 1, sequence: technical.sequence + 1, offset: '1' }]],
    ]),
    quoteHistory: new Map(cut.projection.quoteHistory).set(symbol, [
      ...quotes,
      { ...quote, availableAtMs: at + 1, value: { ...quote.value, eventAt: later } },
    ]),
    tradeHistory: new Map(cut.projection.tradeHistory).set(symbol, [
      ...trades,
      { ...trade, availableAtMs: at + 1, value: { ...trade.value, eventAt: later } },
    ]),
  }
  expect(summarizeStreamingSymbol(projection, symbol, at - 1)).toMatchObject({
    retainedBars: 0,
    retainedFeatures: 0,
    technical: { retainedFeatures: 0 },
    latestQuoteAt: null,
    latestTradeAt: null,
  })
  expect(summarizeStreamingSymbol(projection, symbol, at)).toMatchObject({
    retainedBars: bars.length,
    retainedFeatures: features.length,
    technical: { retainedFeatures: 1 },
    latestQuoteAt: quotes.at(-1)?.value.eventAt,
    latestTradeAt: trades.at(-1)?.value.eventAt,
  })
  expect(summarizeStreamingSymbol(projection, symbol, at + 1)).toMatchObject({
    retainedBars: bars.length + 1,
    retainedFeatures: features.length + 1,
    technical: { retainedFeatures: 2 },
    latestQuoteAt: later,
    latestTradeAt: later,
  })
})
