import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { currentEquityUniverse, intradaySourceTopics } from '../../strategy/intraday-market'
import { checkProperty } from '../../testing/property-test-support'
import {
  SipMarketSession,
  assertHomogeneousFeedCut,
  decodeSipBar,
  decodeSipQuote,
  decodeSipTrade,
  sipTopics,
  sipUniverse,
  validateSipNbboQuote,
} from './index'

// 13:00 New York early close.
const cut = {
  regularOpenAt: '2026-11-27T14:30:00.000Z',
  regularCloseAt: '2026-11-27T18:00:00.000Z',
  observedAt: '2026-11-27T15:00:01.000Z',
  maximumQuoteAgeMs: 1_000,
}
const identity = {
  provider: 'alpaca',
  feed: 'sip',
  delay_class: 'real_time_consolidated',
  universe_id: sipUniverse.id,
  universe_symbol_hash: sipUniverse.symbolHash,
  symbol: 'AAPL',
  market_session: SipMarketSession.Regular,
  event_at: '2026-11-27T15:00:00.000000000Z',
  ingested_at: '2026-11-27T15:00:00.010Z',
  source_partition: 3,
  source_offset: '9007199254740993',
  schema_version: 1,
} as const
const bar = {
  ...identity,
  source_topic: sipTopics.bars,
  channel: 'bars',
  is_final: 1,
  open: 100,
  high: 103,
  low: 99,
  close: 102,
  volume: 2_000,
  vwap: 101,
  trade_count: '42',
} as const
const quote = {
  ...identity,
  source_topic: sipTopics.quotes,
  bid_price: 100,
  bid_size: 20,
  ask_price: 101,
  ask_size: 30,
}
const trade = { ...identity, source_topic: sipTopics.trades, price: 100.5, size: 10 }
const expectSchemaFailure = (result: unknown) =>
  expect(result).toMatchObject({ _tag: 'Failure', failure: { reason: 'schema', cause: { _tag: 'SchemaError' } } })

test('admission preserves the three SIP topic bindings, collected symbols, and raw source coordinates', () => {
  expect(sipTopics).toEqual({
    bars: 'bayn.market-data.sip.bars.1m.v1',
    quotes: 'bayn.market-data.sip.quotes.v1',
    trades: 'bayn.market-data.sip.trades.v1',
  })
  expect(Result.getOrThrow(decodeSipBar(bar))).toEqual(bar)
  expect(Result.getOrThrow(validateSipNbboQuote(quote, cut))).toEqual(quote)
  expect(Result.getOrThrow(decodeSipTrade({ ...trade, symbol: 'SPY' }))).toEqual({ ...trade, symbol: 'SPY' })
})

test.each([
  ['bar', bar, decodeSipBar, intradaySourceTopics.bars, sipTopics.quotes],
  ['quote', quote, decodeSipQuote, intradaySourceTopics.quotes, sipTopics.trades],
  ['trade', trade, decodeSipTrade, intradaySourceTopics.trades, sipTopics.bars],
] as const)('raw SIP %s rejects invalid provenance', (_kind, event, decode, liveTopic, wrongSipTopic) => {
  for (const change of [
    { feed: 'iex', delay_class: 'real_time_exchange_only' },
    { feed: 'iex' },
    { feed: 'delayed_sip', delay_class: 'delayed_15m_consolidated' },
    { feed: 'delayed_sip' },
    { delay_class: 'delayed_15m' },
    { delay_class: 'delayed_15m_consolidated' },
    { delay_class: undefined },
    { universe_id: currentEquityUniverse.id },
    { universe_symbol_hash: currentEquityUniverse.symbolHash },
    { universe_symbol_hash: '0'.repeat(64) },
    { symbol: 'DIA' },
    { source_topic: liveTopic },
    { source_topic: wrongSipTopic },
    { source_partition: -1 },
    { source_offset: -1 },
    { event_at: '2026-02-30T15:00:00.000Z' },
    { market_session: 'continuous' },
    { schema_version: 2 },
  ]) {
    expectSchemaFailure(decode({ ...event, ...change }))
  }
})

test('raw decoders reject impossible bars, nonpositive trades, and nonfinite input', () => {
  for (const change of [{ high: 101 }, { low: 101 }, { open: 0 }, { volume: -1 }, { close: Infinity }])
    expectSchemaFailure(decodeSipBar({ ...bar, ...change }))
  for (const change of [{ price: 0 }, { size: -1 }, { size: NaN }])
    expectSchemaFailure(decodeSipTrade({ ...trade, ...change }))
})

test('RTH NBBO permits locked prices but rejects crossed, negative, zero, and withdrawn quote sides', () => {
  expect(Result.isSuccess(validateSipNbboQuote({ ...quote, ask_price: quote.bid_price }, cut))).toBe(true)
  for (const change of [
    { ask_price: 99 },
    { bid_price: -1 },
    { ask_price: 0 },
    { bid_price: 0 },
    { bid_size: 0 },
    { ask_size: 0 },
  ]) {
    expectSchemaFailure(validateSipNbboQuote({ ...quote, ...change }, cut))
  }
})

test('extended quotes retain their label as raw observations but cannot serve as RTH NBBO', () => {
  for (const session of [
    { market_session: SipMarketSession.Pre, event_at: '2026-11-27T14:29:59.999Z' },
    { market_session: SipMarketSession.Post, event_at: cut.regularCloseAt },
  ]) {
    const extended = { ...quote, ...session }
    expect(Result.getOrThrow(decodeSipQuote(extended)).market_session).toBe(session.market_session)
    expect(validateSipNbboQuote(extended, { ...cut, observedAt: extended.event_at })).toMatchObject({
      _tag: 'Failure',
      failure: { reason: 'quote-session' },
    })
  }
  for (const [eventAt, observedAt] of [
    [cut.observedAt, cut.regularCloseAt],
    [cut.regularCloseAt, '2026-11-27T18:00:00.001Z'],
    ['2026-11-27T14:29:59.999Z', cut.regularOpenAt],
    ['2026-11-25T15:00:00.000Z', cut.observedAt],
  ] as const) {
    expect(validateSipNbboQuote({ ...quote, event_at: eventAt }, { ...cut, observedAt })).toMatchObject({
      _tag: 'Failure',
      failure: { reason: 'quote-session' },
    })
  }
  expect(
    Result.isSuccess(
      validateSipNbboQuote(
        { ...quote, event_at: cut.regularOpenAt, ingested_at: cut.regularOpenAt },
        { ...cut, observedAt: cut.regularOpenAt },
      ),
    ),
  ).toBe(true)
})

test('RTH validation fails closed on a future event, unobserved arrival, or invalid age limit', () => {
  for (const change of [
    { event_at: '2026-11-27T15:00:01.000000001Z' },
    { ingested_at: '2026-11-27T15:00:01.000000001Z' },
  ]) {
    expect(validateSipNbboQuote({ ...quote, ...change }, cut)).toMatchObject({
      _tag: 'Failure',
      failure: { reason: 'quote-time' },
    })
  }
  for (const maximumQuoteAgeMs of [NaN, Infinity, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expectSchemaFailure(validateSipNbboQuote(quote, { ...cut, maximumQuoteAgeMs }))
  }
})

test('property: the caller’s RTH age threshold is inclusive to the nanosecond', () => {
  checkProperty(
    'sip-quote-freshness',
    fc.property(fc.integer({ min: 1, max: 60_000 }), (maximumQuoteAgeMs) => {
      const instant = new Date(Date.parse(quote.event_at) + maximumQuoteAgeMs).toISOString()
      const boundaryCut = { ...cut, maximumQuoteAgeMs, observedAt: instant }
      const arrived = { ...quote, ingested_at: quote.event_at }
      expect(Result.isSuccess(validateSipNbboQuote(arrived, boundaryCut))).toBe(true)
      expect(
        validateSipNbboQuote(arrived, { ...boundaryCut, observedAt: instant.replace('Z', '000001Z') }),
      ).toMatchObject({ _tag: 'Failure', failure: { reason: 'quote-stale' } })
    }),
  )
})

test('an RVOL baseline or projection cannot fall back to IEX or an unknown feed', () => {
  const sipBar = Result.getOrThrow(decodeSipBar(bar))
  const iexBaselineBar = { ...sipBar, feed: 'iex', delay_class: 'real_time_exchange_only' }
  for (const feed of ['iex', 'sip'] as const) {
    expect(assertHomogeneousFeedCut([iexBaselineBar, sipBar], feed)).toMatchObject({
      _tag: 'Failure',
      failure: { reason: 'feed' },
    })
    expect(Result.isSuccess(assertHomogeneousFeedCut([iexBaselineBar, iexBaselineBar], feed))).toBe(feed === 'iex')
    expect(Result.isSuccess(assertHomogeneousFeedCut([sipBar, sipBar], feed))).toBe(feed === 'sip')
    for (const foreign of ['delayed_sip', 'us', undefined])
      expect(Result.isFailure(assertHomogeneousFeedCut([{ feed: foreign }], feed))).toBe(true)
  }
  expect(Result.isSuccess(assertHomogeneousFeedCut([sipBar, Result.getOrThrow(decodeSipTrade(trade))], 'sip'))).toBe(
    true,
  )
})

test('property: one wrong-feed observation invalidates a homogeneous baseline at any position', () => {
  checkProperty(
    'sip-feed-cut',
    fc.property(fc.constantFrom('iex' as const, 'sip' as const), fc.nat(100), fc.nat(100), (feed, before, after) => {
      const baseline = Array.from({ length: before + after + 1 }, () => ({ feed }))
      expect(Result.isSuccess(assertHomogeneousFeedCut(baseline, feed))).toBe(true)
      baseline[before] = { feed: feed === 'sip' ? 'iex' : 'sip' }
      expect(Result.isFailure(assertHomogeneousFeedCut(baseline, feed))).toBe(true)
    }),
  )
})
