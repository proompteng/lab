import assert from 'node:assert/strict'
import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { prepareAccounting } from '../accounting/domain'
import { prepareCashSettlement } from '../accounting/cash-settlement'
import type { CashReportingQuantum } from '../broker/alpaca/cash-reporting'
import { OrderSide } from '../execution/contracts'
import { checkProperty } from '../testing/property-test-support'
import { accountMarkValue } from './valuation'
import { netTradingPnl } from './economics'
import { testHash } from './fixtures.test-support'

test('actual fractional accounting and settlement conserve marked profit across new inventory, partial exits and flat closes', () => {
  checkProperty(
    'system-assessment-accounting-conservation',
    fc.property(
      fc.record({
        quantities: fc.tuple(
          fc.bigInt({ min: 1_000_000n, max: 10_000_000_000n }),
          fc.bigInt({ min: 1_000_000n, max: 10_000_000_000n }),
        ),
        prices: fc.tuple(...Array.from({ length: 4 }, () => fc.bigInt({ min: 1_000_000n, max: 1_000_000_000n }))),
        fees: fc.tuple(
          fc.bigInt({ min: 0n, max: 10_000n }),
          fc.bigInt({ min: 0n, max: 10_000n }),
          fc.bigInt({ min: 0n, max: 10_000n }),
        ),
        sellFraction: fc.integer({ min: 1, max: 10 }),
        quantum: fc.constantFrom<CashReportingQuantum>('1', '10', '100', '1000', '10000'),
      }),
      ({ quantities, prices, fees, sellFraction, quantum }) => {
        let quantity = 0n
        let cost = 0n
        let cash = 100_000_000_000n
        let gross = 0n
        let executionCost = 0n
        let rounding = 0n
        const observed = () => {
          const bid = prices[3]
          assert(bid !== undefined)
          const value = accountMarkValue({
            accountBindingHash: testHash('property account'),
            sourceHash: testHash('property observation'),
            at: '2026-09-18T16:00:00.000Z',
            availableAt: '2026-09-18T16:00:00.000Z',
            cashMicros: cash.toString(),
            valuation: {
              inventorySourceHash: testHash('property inventory'),
              positions:
                quantity === 0n
                  ? []
                  : [
                      {
                        symbol: 'AAPL',
                        quantityAtoms: quantity.toString(),
                        costBasisMicros: cost.toString(),
                        bidPriceMicros: bid.toString(),
                        quoteSourceHash: testHash('property quote'),
                      },
                    ],
            },
          })
          assert(value !== null)
          return { value, gross, executionCost, rounding }
        }
        const openings = [observed()]
        for (let index = 0; index < 3; index++) {
          const price = prices[index]
          const fee = fees[index]
          const fillQuantity = index < 2 ? quantities[index] : (quantity * BigInt(sellFraction)) / 10n
          assert(price !== undefined && fee !== undefined && fillQuantity !== undefined)
          const trade = Result.getOrThrow(
            prepareAccounting(
              testHash({ fill: index }),
              {
                schemaVersion: 'bayn.fill.v2',
                accountId: 'property-account',
                fillId: `fill-${index}`,
                brokerOrderId: `order-${index}`,
                clientOrderId: `client-${index}`,
                symbol: 'AAPL',
                side: index < 2 ? OrderSide.Buy : OrderSide.Sell,
                quantityAtoms: fillQuantity.toString(),
                priceAtoms: (price * 1000n).toString(),
                feeMicros: fee.toString(),
                occurredAt: `2026-09-18T15:30:0${index}.000Z`,
              },
              { quantityAtoms: quantity.toString(), costMicros: cost.toString() },
              7001,
            ),
          ).transaction
          const settlement = Result.getOrThrow(
            prepareCashSettlement(
              {
                schemaVersion: 'bayn.broker-cash-settlement.v1',
                accountId: trade.accountId,
                transactionId: trade.transactionId,
                transactionContentHash: trade.contentHash,
                brokerEventId: trade.brokerEventId,
                cashDeltaMicros: trade.cashDeltaMicros,
                cashReportingQuantumMicros: quantum,
                precisionAccountEventId: testHash('property precision'),
                observedAt: trade.occurredAt,
                occurredAt: trade.occurredAt,
              },
              7001,
            ),
          )
          quantity += BigInt(trade.quantityDeltaAtoms)
          cost += BigInt(trade.costBasisDeltaMicros)
          cash += BigInt(settlement.settledCashDeltaMicros)
          gross += BigInt(trade.realizedPnlMicros)
          executionCost += BigInt(trade.feeMicros)
          rounding += BigInt(settlement.roundingDeltaMicros)
          const close = observed()
          for (const open of openings) {
            expect(
              netTradingPnl({
                grossRealizedPnlMicros: (gross - open.gross).toString(),
                openingUnrealizedPnlMicros: open.value.unrealizedPnlMicros,
                closingUnrealizedPnlMicros: close.value.unrealizedPnlMicros,
                executionCostMicros: (executionCost - open.executionCost).toString(),
                cashSettlementRoundingMicros: (rounding - open.rounding).toString(),
              }),
            ).toBe(BigInt(close.value.equityMicros) - BigInt(open.value.equityMicros))
          }
          openings.push(close)
        }
      },
    ),
    300,
  )
})
