import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { canonicalHashV1, canonicalJsonV1Result } from '../../hash'
import { checkProperty } from '../../testing/property-test-support'
import { decodeRawMarketRecord, RawMarketEventKind } from '../streaming/raw-events'
import { normalizeBar, normalizeQuote, normalizeTrade } from './verification'
import { decodeIntradayBarRows, decodeIntradayQuoteRows, decodeIntradayTradeRows } from './rows'

const marketCase = fc.record({
  cents: fc.integer({ min: 100, max: 100_000 }),
  spread: fc.integer({ min: 0, max: 100 }),
  size: fc.integer({ min: 1, max: 1_000_000 }),
  partition: fc.integer({ min: 0, max: 32 }),
  offset: fc.bigInt({ min: 0n, max: 9_223_372_036_854_775_807n }),
  nanos: fc.integer({ min: 0, max: 999_999_999 }),
  day: fc.integer({ min: 0, max: 366 * 4 }),
  strings: fc.boolean(),
  feed: fc.constantFrom(...(['iex', 'sip', 'delayed_sip'] as const)),
})

type MarketCase = typeof marketCase extends fc.Arbitrary<infer T> ? T : never
const rowsFor = (input: MarketCase) => {
  const wire = (value: number) => (input.strings ? String(value) : value)
  const eventAt = `${new Date(Date.UTC(2024, 0, 1) + input.day * 86_400_000).toISOString().slice(0, 10)}T14:30:00.${String(input.nanos).padStart(9, '0')}Z`
  const identity = {
    provider: 'alpaca',
    universe_id: 'cross-asset-taa-v1',
    universe_symbol_hash: 'a'.repeat(64),
    feed: input.feed,
    market_session: 'regular',
    delay_class:
      input.feed === 'iex'
        ? 'real_time_exchange_only'
        : input.feed === 'sip'
          ? 'real_time_consolidated'
          : 'delayed_15m_consolidated',
    symbol: 'AAPL',
    event_at: eventAt,
    ingested_at: eventAt,
    source_topic: 'synthetic.bars',
    source_partition: wire(input.partition),
    source_offset: String(input.offset),
    schema_version: input.strings ? '1' : 1,
  } as const
  const price = input.cents / 100
  return {
    bar: {
      ...identity,
      channel: 'bars',
      is_final: input.strings ? '1' : 1,
      open: wire(price),
      high: wire(price + 1),
      low: wire(price - 0.5),
      close: wire(price),
      volume: wire(input.size),
      vwap: wire(price),
      trade_count: String(input.size),
    },
    quote: {
      ...identity,
      source_topic: 'synthetic.quotes',
      bid_price: wire(price),
      ask_price: wire((input.cents + input.spread) / 100),
      bid_size: wire(input.size),
      ask_size: wire(input.size),
    },
    trade: { ...identity, source_topic: 'synthetic.trades', price: wire(price), size: wire(input.size) },
  } as const
}

const reverseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, nested]) => [key, reverseKeys(nested)]),
    )
  return value
}

describe('market boundary properties', () => {
  test('property: valid archive rows survive strict decoding and normalize numeric representations', () => {
    checkProperty(
      'archive-roundtrip',
      fc.property(marketCase, (input) => {
        const rows = rowsFor(input)
        const numeric = rowsFor({ ...input, strings: false })
        const bar = Result.getOrThrow(decodeIntradayBarRows([rows.bar]))[0]
        const quote = Result.getOrThrow(decodeIntradayQuoteRows([rows.quote]))[0]
        const trade = Result.getOrThrow(decodeIntradayTradeRows([rows.trade]))[0]
        expect(bar).toEqual(rows.bar)
        expect(quote).toEqual(rows.quote)
        expect(trade).toEqual(rows.trade)
        expect(Result.getOrThrow(normalizeBar(bar))).toEqual(Result.getOrThrow(normalizeBar(numeric.bar)))
        expect(Result.getOrThrow(normalizeQuote(quote))).toEqual(Result.getOrThrow(normalizeQuote(numeric.quote)))
        expect(Result.getOrThrow(normalizeTrade(trade))).toEqual(Result.getOrThrow(normalizeTrade(numeric.trade)))
      }),
    )
  })

  test('property: one invalid member poisons an archive batch without poisoning the reused decoder', () => {
    checkProperty(
      'archive-mutations',
      fc.property(marketCase, fc.integer({ min: 0, max: 6 }), (input, mutation) => {
        const { bar, quote, trade } = rowsFor(input)
        const patches = [
          { unexpected: true },
          { schema_version: 2 },
          { source_partition: -1 },
          { source_offset: '-1' },
          { event_at: quote.event_at.replace('Z', '+00:00') },
          { ingested_at: quote.ingested_at.replace('T14:', 'T25:') },
          { universe_id: ' bad ' },
        ]
        for (const [row, decode] of [
          [bar, decodeIntradayBarRows],
          [quote, decodeIntradayQuoteRows],
          [trade, decodeIntradayTradeRows],
        ] as const) {
          const invalid = decode([row, { ...row, ...patches[mutation] }, row])
          expect(invalid).toMatchObject({ _tag: 'Failure', failure: { reason: 'rows' } })
          const recovered: unknown = decode([row])
          expect(recovered).toEqual(Result.succeed([row]))
        }
        expect(
          Result.isFailure(decodeIntradayQuoteRows([{ ...quote, bid_price: Number(quote.ask_price) + 0.01 }])),
        ).toBe(true)
        expect(Result.isFailure(decodeIntradayBarRows([{ ...bar, high: Number(bar.open) - 0.01 }]))).toBe(true)
        expect(Result.isFailure(decodeIntradayTradeRows([{ ...trade, size: 0 }]))).toBe(true)
      }),
    )
  })

  test('property: canonical evidence ignores object insertion order but binds values and array order', () => {
    checkProperty(
      'canonical-market-evidence',
      fc.property(fc.array(marketCase, { minLength: 1, maxLength: 8 }), (inputs) => {
        const rows = inputs.map(rowsFor)
        const evidence = { records: rows, source: { provider: 'alpaca', revision: 1 } }
        const canonical = Result.getOrThrow(canonicalJsonV1Result(evidence))
        expect(canonicalHashV1(reverseKeys(evidence))).toBe(canonicalHashV1(evidence))
        expect(Result.getOrThrow(canonicalJsonV1Result(JSON.parse(canonical)))).toBe(canonical)
        expect(canonicalHashV1({ ...evidence, source: { provider: 'alpaca', revision: 2 } })).not.toBe(
          canonicalHashV1(evidence),
        )
        expect(canonicalHashV1([evidence, 'end'])).not.toBe(canonicalHashV1(['end', evidence]))
      }),
    )
  })

  test('property: structured wire fuzzing rejects truncated JSON and invalid quote payloads', () => {
    checkProperty(
      'raw-wire-fuzz',
      fc.property(marketCase, fc.nat(), (input, selector) => {
        const { quote } = rowsFor({ ...input, feed: 'iex' })
        const universe = {
          universeId: quote.universe_id,
          universeSymbolHash: quote.universe_symbol_hash,
          symbols: ['AAPL'],
          topics: {
            bars: 'synthetic.bars',
            quotes: 'synthetic.quotes',
            trades: 'synthetic.trades',
            features: 'synthetic.features',
          },
        }
        const payload = {
          bp: Number(quote.bid_price),
          ap: Number(quote.ask_price),
          bs: Number(quote.bid_size),
          as: Number(quote.ask_size),
          t: quote.event_at,
        }
        const envelope = {
          provider: 'alpaca',
          feed: 'iex',
          delayClass: 'real_time_exchange_only',
          marketSession: 'regular',
          channel: 'quotes',
          symbol: 'AAPL',
          eventTs: quote.event_at,
          ingestTs: quote.ingested_at,
          version: 2,
          payload,
        }
        const record = {
          topic: universe.topics.quotes,
          partition: input.partition,
          offset: String(input.offset),
          value: JSON.stringify(envelope),
        }
        const accepted = Result.getOrThrow(decodeRawMarketRecord(record, universe))
        expect(accepted.kind).toBe(RawMarketEventKind.Quote)
        const truncated = record.value.slice(0, selector % record.value.length)
        expect(Result.isFailure(decodeRawMarketRecord({ ...record, value: truncated }, universe))).toBe(true)
        for (const value of [null, 'NaN', -1, [], {}]) {
          const corrupt = JSON.stringify({ ...envelope, payload: { ...payload, ap: value } })
          expect(Result.isFailure(decodeRawMarketRecord({ ...record, value: corrupt }, universe))).toBe(true)
        }
        expect(Result.getOrThrow(decodeRawMarketRecord(record, universe))).toEqual(accepted)
      }),
    )
  })
})
