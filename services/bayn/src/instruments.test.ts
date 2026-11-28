import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { decodeInstrument, InstrumentSymbolSchema, MarketKind, validateInstrumentOrder } from './instruments'

test('the same instrument contract admits equities and all supported crypto pairs', () => {
  for (const symbol of ['AAPL', 'BTC/USD', 'ETH/USD', 'SOL/USD'])
    expect(Schema.is(InstrumentSymbolSchema)(symbol)).toBe(true)
  for (const symbol of ['BTCUSD', 'ETHUSD', 'SOLUSD', 'BTC/ETH', 'btc/usd', 'BTC//USD'])
    expect(Schema.is(InstrumentSymbolSchema)(symbol)).toBe(false)
  const equity = Result.getOrThrow(
    decodeInstrument({
      symbol: 'AAPL',
      assetClass: 'us_equity',
      minimumOrderSize: null,
      quantityIncrement: null,
      priceIncrement: null,
    }),
  )
  expect(equity.market).toBe(MarketKind.Equity)
  for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD']) {
    const crypto = Result.getOrThrow(
      decodeInstrument({
        symbol,
        assetClass: 'crypto',
        minimumOrderSize: '0.00001215',
        quantityIncrement: '0.000000001',
        priceIncrement: '0.000000001',
      }),
    )
    expect(crypto.market).toBe(MarketKind.Crypto)
    expect(crypto.minimumQuantityAtoms).toBe(12_150n)
  }
})

test('instrument metadata rejects missing crypto increments and mixed identities', () => {
  for (const input of [
    {
      symbol: 'BTC/USD',
      assetClass: 'crypto' as const,
      minimumOrderSize: null,
      quantityIncrement: null,
      priceIncrement: null,
    },
    {
      symbol: 'AAPL',
      assetClass: 'crypto' as const,
      minimumOrderSize: '1',
      quantityIncrement: '1',
      priceIncrement: '0.01',
    },
    {
      symbol: 'BTC/USD',
      assetClass: 'crypto' as const,
      minimumOrderSize: '0',
      quantityIncrement: '0.000000001',
      priceIncrement: '0.000000001',
    },
  ])
    expect(Result.isFailure(decodeInstrument(input))).toBe(true)
})

test('the shared instrument guard enforces minimums, steps, prices and continuous market durations', () => {
  const instrument = Result.getOrThrow(
    decodeInstrument({
      symbol: 'SOL/USD',
      assetClass: 'crypto',
      minimumOrderSize: '0.009492168',
      quantityIncrement: '0.000000010',
      priceIncrement: '0.000000010',
    }),
  )
  const order = { symbol: 'SOL/USD', side: 'BUY', quantityAtoms: '9492170', orderType: 'LIMIT', timeInForce: 'IOC' }
  const terms = { closeOnly: false, fractionable: true, limitPriceAtoms: 100_000_000_010n }
  expect(Result.isSuccess(validateInstrumentOrder(instrument, order, terms))).toBe(true)
  for (const changed of [{ quantityAtoms: '9492160' }, { quantityAtoms: '9492171' }, { timeInForce: 'DAY' }])
    expect(Result.isFailure(validateInstrumentOrder(instrument, { ...order, ...changed }, terms))).toBe(true)
  expect(
    Result.isFailure(validateInstrumentOrder(instrument, order, { ...terms, limitPriceAtoms: 100_000_000_011n })),
  ).toBe(true)
  expect(
    Result.isFailure(validateInstrumentOrder(instrument, { ...order, orderType: 'MARKET', timeInForce: 'GTC' }, terms)),
  ).toBe(true)
  expect(
    Result.isFailure(validateInstrumentOrder(instrument, { ...order, orderType: 'MARKET', timeInForce: 'DAY' }, terms)),
  ).toBe(true)
})

test('fractional equities use LIMIT/DAY while retaining the asset capability and price guards', () => {
  const instrument = Result.getOrThrow(
    decodeInstrument({
      symbol: 'AAPL',
      assetClass: 'us_equity',
      minimumOrderSize: null,
      quantityIncrement: null,
      priceIncrement: null,
    }),
  )
  const order = { symbol: 'AAPL', side: 'BUY', quantityAtoms: '500000000', orderType: 'LIMIT', timeInForce: 'DAY' }
  const terms = { closeOnly: true, fractionable: true, limitPriceAtoms: 100000000000n }
  expect(Result.isSuccess(validateInstrumentOrder(instrument, order, terms))).toBe(true)
  expect(Result.isFailure(validateInstrumentOrder(instrument, order, { ...terms, fractionable: false }))).toBe(true)
  expect(Result.isFailure(validateInstrumentOrder(instrument, { ...order, timeInForce: 'IOC' }, terms))).toBe(true)
  expect(Result.isFailure(validateInstrumentOrder(instrument, { ...order, orderType: 'MARKET' }, terms))).toBe(true)
})

test('crypto protective stops require close-only sells, GTC and valid stop and limit ticks', () => {
  const instrument = Result.getOrThrow(
    decodeInstrument({
      symbol: 'BTC/USD',
      assetClass: 'crypto',
      minimumOrderSize: '0.00001215',
      quantityIncrement: '0.000000010',
      priceIncrement: '0.000000010',
    }),
  )
  const order = {
    symbol: 'BTC/USD',
    side: 'SELL',
    quantityAtoms: '1500000',
    orderType: 'STOP_LIMIT',
    timeInForce: 'GTC',
  }
  const terms = {
    closeOnly: true,
    fractionable: true,
    limitPriceAtoms: 81_016_592_310_000n,
    stopPriceAtoms: 81_097_690_000_000n,
  }
  expect(Result.isSuccess(validateInstrumentOrder(instrument, order, terms))).toBe(true)
  for (const changed of [
    { side: 'BUY' },
    { timeInForce: 'IOC' },
    { timeInForce: 'DAY' },
    { orderType: 'MARKET' },
    { quantityAtoms: '1500001' },
  ])
    expect(Result.isFailure(validateInstrumentOrder(instrument, { ...order, ...changed }, terms))).toBe(true)
  for (const changed of [
    { closeOnly: false },
    { limitPriceAtoms: terms.limitPriceAtoms + 1n },
    { limitPriceAtoms: terms.stopPriceAtoms + 10n },
    { stopPriceAtoms: 0n },
    { stopPriceAtoms: terms.stopPriceAtoms + 1n },
  ])
    expect(Result.isFailure(validateInstrumentOrder(instrument, order, { ...terms, ...changed }))).toBe(true)
  const { stopPriceAtoms: _, ...withoutStop } = terms
  expect(Result.isFailure(validateInstrumentOrder(instrument, order, withoutStop))).toBe(true)
  expect(Result.isFailure(validateInstrumentOrder({ ...instrument, market: MarketKind.Equity }, order, terms))).toBe(
    true,
  )
})
