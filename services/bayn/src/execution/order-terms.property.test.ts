import { OrderType as BrokerOrderType, TimeInForce as BrokerTimeInForce } from '../broker/alpaca/model'
import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { orderRequestBody } from '../broker/alpaca-mutations/decisions'
import { instrumentMarket, MarketKind } from '../instruments'
import { checkProperty } from '../testing/property-test-support'
import { OrderSide, OrderType, TimeInForce } from './contracts'
import { cashSpotLimitTimeInForce } from './order-terms'

test('property: one limit encoder binds asset duration, exact price and extended-hours eligibility', () => {
  checkProperty(
    'cash-spot-session-limit-orders',
    fc.property(
      fc.constantFrom('AAPL', 'BTC/USD', 'ETH/USD', 'SOL/USD'),
      fc.constantFrom(OrderSide.Buy, OrderSide.Sell),
      fc.integer({ min: 100, max: 1_000_000 }),
      fc.integer({ min: 1, max: 1000 }),
      (symbol, side, cents, units) => {
        const market = instrumentMarket(symbol)
        const quantity = BigInt(units) * (market === MarketKind.Equity ? 1_000_000_000n : 100_000n)
        const price = BigInt(cents) * 10_000n
        const intent = {
          symbol,
          side,
          orderType: OrderType.Limit,
          timeInForce: cashSpotLimitTimeInForce(market),
          quantityAtoms: String(quantity),
          notionalLimitMicros: String((quantity * price + (side === OrderSide.Buy ? 999999999n : 0n)) / 1_000_000_000n),
          limitPriceMicros: price.toString(),
          clientOrderId: 'b1_' + 'A'.repeat(43),
        }
        const request = Result.getOrThrow(orderRequestBody(intent))
        expect(request.type).toBe(BrokerOrderType.Limit)
        expect(request.time_in_force).toBe(
          market === MarketKind.Equity ? BrokerTimeInForce.Day : BrokerTimeInForce.ImmediateOrCancel,
        )
        expect(request.extended_hours).toBe(market === MarketKind.Equity)
        if (request.type !== 'limit') throw new Error('Expected bounded limit order')
        expect(Number(request.limit_price)).toBe(cents / 100)
        expect(
          orderRequestBody({
            ...intent,
            timeInForce: market === MarketKind.Equity ? TimeInForce.ImmediateOrCancel : TimeInForce.Day,
          })._tag,
        ).toBe('Failure')
      },
    ),
  )
})

test('property: fractional closes retain one explicit LIMIT price and the native asset duration', () => {
  checkProperty(
    'cash-spot-fractional-close-terms',
    fc.property(
      fc.constantFrom('AAPL', 'BTC/USD', 'ETH/USD', 'SOL/USD'),
      fc.bigInt({ min: 1n, max: 999_999_999n }),
      (symbol, fraction) => {
        const market = instrumentMarket(symbol)
        const quantity = 1_000_000_000n + fraction
        const price = 100_010_000n
        const request = Result.getOrThrow(
          orderRequestBody({
            symbol,
            side: OrderSide.Sell,
            orderType: OrderType.Limit,
            timeInForce: cashSpotLimitTimeInForce(market),
            quantityAtoms: quantity.toString(),
            notionalLimitMicros: ((quantity * price) / 1000000000n).toString(),
            limitPriceMicros: price.toString(),
            clientOrderId: 'b1_' + 'A'.repeat(43),
          }),
        )
        expect(request.type).toBe(BrokerOrderType.Limit)
        expect(request.time_in_force).toBe(
          market === MarketKind.Equity ? BrokerTimeInForce.Day : BrokerTimeInForce.ImmediateOrCancel,
        )
        expect(request.extended_hours).toBe(market === MarketKind.Equity)
        expect(Math.round(Number(request.qty) * 1_000_000_000)).toBe(Number(quantity))
      },
    ),
  )
})
