import { cryptoMaximumTakerFeeBps } from '../broker/crypto-fees'
import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { deriveExecutionIntentPricing } from '../execution/intent-pricing'
import { cashSpotLimitTimeInForce } from '../execution/order-terms'
import { instrumentMarket } from '../instruments'
import { calculateSessionFees } from '../strategy/execution-model/fees'
import {
  jevBreakEvenExitBid,
  jevBreakEvenExitLimitPrice,
  jevExitLimitValue,
  jevLiquidationValue,
} from './liquidation-economics'
import { defaultJevProtocolDocument } from './protocol'

test.each(['BTC/USD', 'ETH/USD', 'SOL/USD', 'NVDA'])(
  '%s take-profit break-even uses its actual limit and preserves exit fees',
  (symbol) => {
    const input = { protocol: defaultJevProtocolDocument, symbol, quantityAtoms: 100_000_000_000n }
    const acquisitionCostMicros = 10_000_000_000n
    const limit = Result.getOrThrow(
      jevBreakEvenExitLimitPrice({ ...input, acquisitionCostMicros, upperLimitPriceMicros: 200_000_000n }),
    )
    const value = Result.getOrThrow(jevExitLimitValue({ ...input, limitPriceMicros: limit }))
    const proceeds = (limit * input.quantityAtoms) / 1_000_000_000n
    const fees = Result.getOrThrow(
      calculateSessionFees(
        [{ symbol, side: 'sell', quantityAtoms: input.quantityAtoms, notionalMicros: proceeds }],
        input.protocol.executionModel,
        1_000_000n,
        cryptoMaximumTakerFeeBps,
      ),
    )
    expect(value.proceedsMicros).toBe(proceeds)
    expect(value.netMicros).toBe(proceeds - fees.cashMicros)
    expect(value.conservativeNetMicros).toBeLessThanOrEqual(value.netMicros)
    expect(value.conservativeNetMicros).toBeGreaterThanOrEqual(acquisitionCostMicros)
    expect(
      Result.getOrThrow(jevExitLimitValue({ ...input, limitPriceMicros: limit - 1n })).conservativeNetMicros,
    ).toBeLessThan(acquisitionCostMicros)
    expect(
      Result.getOrThrow(jevBreakEvenExitBid({ ...input, acquisitionCostMicros, upperBidMicros: 200_000_000n })),
    ).toBeGreaterThan(limit)
  },
)

test('an exit limit rejects a nonpositive price or quantity', () => {
  for (const [limitPriceMicros, quantityAtoms] of [
    [0n, 1n],
    [1n, 0n],
    [1n, -1n],
  ]) {
    expect(
      Result.isFailure(
        jevExitLimitValue({ protocol: defaultJevProtocolDocument, symbol: 'NVDA', limitPriceMicros, quantityAtoms }),
      ),
    ).toBe(true)
  }
})

test.each(['BTC/USD', 'ETH/USD', 'SOL/USD', 'NVDA'])(
  '%s break-even is the conservative market bid funds a native bounded sell across fee rounding steps',
  (symbol) => {
    const protocol = defaultJevProtocolDocument
    const quantityAtoms = 100_000_000_000n
    const acquisitionCostMicros = 10_000_000_000n
    const input = { protocol, symbol, quantityAtoms }
    const bid = Result.getOrThrow(
      jevBreakEvenExitBid({ ...input, acquisitionCostMicros, upperBidMicros: 200_000_000n }),
    )
    const nativeCash = (bidMicros: bigint) => {
      const pricing = Result.getOrThrow(
        deriveExecutionIntentPricing({
          symbol,
          side: OrderSide.Sell,
          orderType: OrderType.Limit,
          timeInForce: cashSpotLimitTimeInForce(instrumentMarket(symbol)),
          quantityAtoms,
          referencePriceMicros: bidMicros,
          limitSlippageBps: 10n,
        }),
      )
      const proceeds = (pricing.expectedExecutionPriceMicros * quantityAtoms) / 1_000_000_000n
      const fees = Result.getOrThrow(
        calculateSessionFees(
          [{ symbol, side: 'sell', quantityAtoms, notionalMicros: proceeds }],
          protocol.executionModel,
          1_000_000n,
          cryptoMaximumTakerFeeBps,
        ),
      )
      return proceeds - fees.cashMicros
    }
    expect(nativeCash(bid)).toBeGreaterThanOrEqual(acquisitionCostMicros)
    expect(
      Result.getOrThrow(jevLiquidationValue({ ...input, bidMicros: bid })).conservativeNetMicros,
    ).toBeGreaterThanOrEqual(acquisitionCostMicros)
    expect(
      Result.getOrThrow(jevLiquidationValue({ ...input, bidMicros: bid - 1n })).conservativeNetMicros,
    ).toBeLessThan(acquisitionCostMicros)
    expect(nativeCash(bid - 1n)).toBeLessThan(acquisitionCostMicros + 10_000n)
    for (const higher of [1n, 10n, 100n, 1_000n, 10_000n])
      expect(nativeCash(bid + higher)).toBeGreaterThanOrEqual(acquisitionCostMicros)
    expect(Result.getOrThrow(jevLiquidationValue({ ...input, bidMicros: bid })).netMicros).toBe(nativeCash(bid))
    expect(bid).toBeGreaterThan(100_000_000n)
  },
)

test('an inadequate price bound cannot produce a break-even estimate', () => {
  const result = jevBreakEvenExitBid({
    protocol: defaultJevProtocolDocument,
    symbol: 'BTC/USD',
    quantityAtoms: 1_000_000_000n,
    acquisitionCostMicros: 100_000_000n,
    upperBidMicros: 100_000_000n,
  })
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure.message).toBe('Liquidation has no bounded break-even bid')
})

test('invalid native sell terms retain the pricing failure', () => {
  const result = jevLiquidationValue({
    protocol: defaultJevProtocolDocument,
    symbol: 'NVDA',
    quantityAtoms: 0n,
    bidMicros: 100_000_000n,
  })
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure.cause).toMatchObject({ _tag: 'InvalidQuoteBoundIntent' })
})

test('a cent-rounded fee jump above the break-even bid remains funded', () => {
  const protocol = defaultJevProtocolDocument
  const quantityAtoms = 59_468_593_953n
  const acquisitionCostMicros = 128_059_041_016n
  const input = { protocol, symbol: 'BTC/USD', quantityAtoms }
  expect(Result.getOrThrow(jevLiquidationValue({ ...input, bidMicros: 2_160_947_485n })).netMicros).toBe(
    acquisitionCostMicros - 957n,
  )
  const bid = Result.getOrThrow(
    jevBreakEvenExitBid({ ...input, acquisitionCostMicros, upperBidMicros: 4_300_000_000n }),
  )
  for (let higher = 0n; higher <= 400n; higher++)
    expect(
      Result.getOrThrow(jevLiquidationValue({ ...input, bidMicros: bid + higher })).netMicros,
    ).toBeGreaterThanOrEqual(acquisitionCostMicros)
})

test('the conservative cash floor remains monotone across an actual cent fee jump', () => {
  const input = { protocol: defaultJevProtocolDocument, symbol: 'BTC/USD', quantityAtoms: 1_000_000_000n }
  const before = Result.getOrThrow(jevLiquidationValue({ ...input, bidMicros: 92_092_092n }))
  const after = Result.getOrThrow(jevLiquidationValue({ ...input, bidMicros: 92_092_093n }))
  expect(before.netMicros).toBeGreaterThanOrEqual(91_770_000n)
  expect(after.netMicros).toBeLessThan(91_770_000n)
  expect(after.conservativeNetMicros).toBeGreaterThanOrEqual(before.conservativeNetMicros)
  expect(before.conservativeNetMicros).toBeLessThanOrEqual(before.netMicros)
  expect(after.conservativeNetMicros).toBeLessThanOrEqual(after.netMicros)
})

test('fractional equity liquidation uses the same explicit LIMIT/DAY pricing', () => {
  const protocol = defaultJevProtocolDocument
  const input = { protocol, symbol: 'NVDA', quantityAtoms: 250_000_000n, bidMicros: 100_000_000n }
  const pricing = Result.getOrThrow(
    deriveExecutionIntentPricing({
      symbol: input.symbol,
      side: OrderSide.Sell,
      orderType: OrderType.Limit,
      timeInForce: TimeInForce.Day,
      quantityAtoms: input.quantityAtoms,
      referencePriceMicros: input.bidMicros,
      limitSlippageBps: BigInt(protocol.maximumEntryLimitSlippageBps),
    }),
  )
  expect(Result.getOrThrow(jevLiquidationValue(input)).proceedsMicros).toBe(pricing.notionalLimitMicros)
  const bid = Result.getOrThrow(
    jevBreakEvenExitBid({ ...input, acquisitionCostMicros: 25_000_000n, upperBidMicros: 200_000_000n }),
  )
  expect(Result.getOrThrow(jevLiquidationValue({ ...input, bidMicros: bid })).netMicros).toBeGreaterThanOrEqual(
    25_000_000n,
  )
})
