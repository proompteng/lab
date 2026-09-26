import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1 } from '../../hash'
import { decodeIntradayQuoteRows, decodeIntradayTradeRows } from '../intraday/rows'
import { normalizeQuote, normalizeTrade, persistIntradayRecordRows } from '../intraday/verification'
import { decodeRawMarketRecord, RawMarketEventKind, type StreamingUniverse } from './raw-events'

const at = '2026-09-18T14:30:00.000000000Z'
const universe: StreamingUniverse = {
  universeId: 'provider-metadata-fixture',
  universeSymbolHash: 'a'.repeat(64),
  symbols: ['AAPL'],
  topics: { bars: 'bars', quotes: 'quotes', trades: 'trades', features: 'features' },
}
const record = (channel: 'quotes' | 'trades', payload: object) => ({
  topic: universe.topics[channel],
  partition: 0,
  offset: '1',
  value: JSON.stringify({
    provider: 'alpaca',
    feed: 'iex',
    delayClass: 'real_time_exchange_only',
    marketSession: 'regular',
    channel,
    symbol: 'AAPL',
    eventTs: at,
    ingestTs: at,
    version: 2,
    isFinal: true,
    payload: { ...payload, t: at },
  }),
})
const quote = (metadata: object = {}) => {
  const decoded = Result.getOrThrow(
    decodeRawMarketRecord(record('quotes', { bp: 100, bs: 1, ap: 100.01, as: 2, ...metadata }), universe),
  )
  if (decoded.kind !== RawMarketEventKind.Quote) throw new Error('Expected a decoded quote')
  return decoded.value
}
const trade = (metadata: object = {}) => {
  const decoded = Result.getOrThrow(
    decodeRawMarketRecord(record('trades', { p: 100.01, s: 10, ...metadata }), universe),
  )
  if (decoded.kind !== RawMarketEventKind.Trade) throw new Error('Expected a decoded trade')
  return decoded.value
}

describe('Alpaca raw evidence metadata', () => {
  test('retains the provider trade identity and conditions through durable row round trips', () => {
    const value = trade({ i: 52983525033527, x: 'V', c: [' ', '7'], z: 'B' })
    const metadata = { id: '52983525033527', exchange: 'V', conditions: [' ', '7'], tape: 'B' }
    expect(value).toHaveProperty('providerMetadata', metadata)
    const rows = Result.getOrThrow(persistIntradayRecordRows({ bars: [], quotes: [], trades: [value] }))
    const decoded = Result.getOrThrow(decodeIntradayTradeRows(rows.trades))
    const restored = Result.getOrThrow(Result.all(decoded.map(normalizeTrade)))
    expect(restored).toEqual([value])
    expect(restored[0]).toHaveProperty('providerMetadata', metadata)
  })

  test('retains quote exchange, condition and tape without inventing a quantity conversion', () => {
    const value = quote({ bx: 'V', ax: 'V', c: ['R'], z: 'C' })
    const metadata = { bidExchange: 'V', askExchange: 'V', conditions: ['R'], tape: 'C' }
    expect(value).toHaveProperty('providerMetadata', metadata)
    expect(value).toMatchObject({ bidSize: 1, askSize: 2 })
    const rows = Result.getOrThrow(persistIntradayRecordRows({ bars: [], quotes: [value], trades: [] }))
    const decoded = Result.getOrThrow(decodeIntradayQuoteRows(rows.quotes))
    const restored = Result.getOrThrow(Result.all(decoded.map(normalizeQuote)))
    expect(restored).toEqual([value])
    expect(restored[0]).toHaveProperty('providerMetadata', metadata)
  })

  test('keeps different trade IDs and conditions distinct in normalized evidence', () => {
    const original = trade({ i: 123, x: 'V', c: ['@'] })
    expect(canonicalHashV1(trade({ i: 456, x: 'V', c: ['@'] }))).not.toBe(canonicalHashV1(original))
    expect(canonicalHashV1(trade({ i: 123, x: 'V', c: ['Z'] }))).not.toBe(canonicalHashV1(original))
  })

  test('keeps missing metadata distinct from explicit empty or unknown provider values', () => {
    expect(trade()).not.toHaveProperty('providerMetadata')
    expect(quote()).not.toHaveProperty('providerMetadata')
    expect(trade({ c: [] })).toHaveProperty('providerMetadata', { conditions: [] })
    expect(trade({ i: null, x: null, c: null, z: null })).toHaveProperty('providerMetadata', {
      id: null,
      exchange: null,
      conditions: null,
      tape: null,
    })
  })

  test('rejects an unsafe numeric trade ID rather than retaining a rounded identity', () => {
    const decoded = decodeRawMarketRecord(record('trades', { p: 100, s: 1, i: Number.MAX_SAFE_INTEGER + 1 }), universe)
    expect(Result.isFailure(decoded)).toBe(true)
  })

  test('retains an exact string trade ID outside the JavaScript safe integer range', () => {
    expect(trade({ i: '9007199254740993' })).toHaveProperty('providerMetadata', { id: '9007199254740993' })
  })

  test.each([{ i: -1 }, { i: 1.5 }, { i: '001' }, { i: 'not-an-id' }, { c: ['R', 42] }])(
    'rejects malformed provider metadata %j',
    (metadata) => {
      expect(Result.isFailure(decodeRawMarketRecord(record('trades', { p: 100, s: 1, ...metadata }), universe))).toBe(
        true,
      )
    },
  )
})
