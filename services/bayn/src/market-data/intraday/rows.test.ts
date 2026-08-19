import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { decodeIntradayBarRows, decodeIntradayQuoteRows, decodeIntradayTradeRows } from './rows'

const identity = {
  provider: 'alpaca',
  universe_id: 'torghut-core-equity-v1',
  universe_symbol_hash: 'a'.repeat(64),
  feed: 'sip',
  market_session: 'regular',
  delay_class: 'real_time_consolidated',
  symbol: 'NVDA',
  event_at: '2026-08-18T13:35:15.123456789Z',
  ingested_at: '2026-08-18T13:35:15.223456789Z',
  source_topic: 'torghut.quotes.v1',
  source_partition: '0',
  source_offset: '42',
  schema_version: '1',
} as const

describe('intraday archive row decoding', () => {
  test('enforces the archived bar market invariants', () => {
    const bar = {
      ...identity,
      event_at: '2026-08-18T13:35:00.000Z',
      ingested_at: '2026-08-18T13:36:00.000Z',
      source_topic: 'torghut.bars.v1',
      channel: 'bars',
      is_final: '1',
      open: '100.00',
      high: '101.00',
      low: '99.50',
      close: '100.50',
      volume: '1000',
      vwap: '100.25',
      trade_count: '50',
    } as const
    expect(Result.isSuccess(decodeIntradayBarRows([bar]))).toBe(true)
    expect(Result.isFailure(decodeIntradayBarRows([{ ...bar, open: '0' }]))).toBe(true)
    expect(Result.isFailure(decodeIntradayBarRows([{ ...bar, high: '100.49' }]))).toBe(true)
    expect(Result.isFailure(decodeIntradayBarRows([{ ...bar, low: '100.01' }]))).toBe(true)
    expect(Result.isFailure(decodeIntradayBarRows([{ ...bar, volume: '-1' }]))).toBe(true)
    expect(Result.isFailure(decodeIntradayBarRows([{ ...bar, vwap: '0' }]))).toBe(true)
  })

  test('accepts finite numeric strings and rejects non-finite market values', () => {
    const quote = {
      ...identity,
      bid_price: '100.01',
      bid_size: '12',
      ask_price: '100.02',
      ask_size: '13',
    }
    expect(Result.isSuccess(decodeIntradayQuoteRows([quote]))).toBe(true)
    expect(Result.isFailure(decodeIntradayQuoteRows([{ ...quote, ask_price: 'NaN' }]))).toBe(true)
    expect(Result.isFailure(decodeIntradayQuoteRows([{ ...quote, bid_size: 'Infinity' }]))).toBe(true)
    expect(Result.isFailure(decodeIntradayQuoteRows([{ ...quote, ask_size: ' 13' }]))).toBe(true)
    expect(Result.isFailure(decodeIntradayQuoteRows([{ ...quote, bid_price: '0' }]))).toBe(true)
    expect(Result.isFailure(decodeIntradayQuoteRows([{ ...quote, ask_price: '-1' }]))).toBe(true)
    expect(Result.isFailure(decodeIntradayQuoteRows([{ ...quote, bid_size: '-1' }]))).toBe(true)
    expect(Result.isFailure(decodeIntradayQuoteRows([{ ...quote, ask_size: '-1' }]))).toBe(true)
    expect(Result.isFailure(decodeIntradayQuoteRows([{ ...quote, bid_price: '100.03' }]))).toBe(true)

    const trade = {
      ...identity,
      source_topic: 'torghut.trades.v1',
      price: '100.015',
      size: '5',
    }
    expect(Result.isSuccess(decodeIntradayTradeRows([trade]))).toBe(true)
    expect(Result.isFailure(decodeIntradayTradeRows([{ ...trade, price: '-Infinity' }]))).toBe(true)
    expect(Result.isFailure(decodeIntradayTradeRows([{ ...trade, price: '0' }]))).toBe(true)
    expect(Result.isFailure(decodeIntradayTradeRows([{ ...trade, size: '-1' }]))).toBe(true)
  })
})
