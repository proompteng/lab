import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { intradayMomentumExecutionModel } from '../strategy/intraday-momentum/protocol'
import { checkProperty } from '../testing/property-test-support'
import { applyReplayFill, createReplayLedger, type EconomicReplayFill } from './ledger'

const scenario = fc.record({
  // Each generated part is a later partial close of one partially filled entry.
  parts: fc.array(fc.bigInt({ min: 1n, max: 20_000_000n }), { minLength: 2, maxLength: 8 }),
  entryPrice: fc.bigInt({ min: 1_000_000n, max: 1_000_000_000n }),
  exitPrice: fc.bigInt({ min: 1_000_000n, max: 1_000_000_000n }),
  unfilledQuantity: fc.bigInt({ min: 1n, max: 10_000_000n }),
  feeMultiplier: fc.integer({ min: 1_000_000, max: 10_000_000 }),
  symbol: fc.constantFrom('AAPL', 'NVDA', 'IWM'),
})

// Deliberately independent of the production fixed-point/notional helper.
const notional = (quantity: bigint, price: bigint): bigint => (quantity * price + 500_000n) / 1_000_000n
const makeFill = (symbol: string, side: 'buy' | 'sell', quantity: bigint, price: bigint): EconomicReplayFill => ({
  symbol,
  side,
  quantityMicros: String(quantity),
  priceMicros: String(price),
  notionalMicros: String(notional(quantity, price)),
  observedAt: '2026-09-04T14:30:00.000Z',
})

describe('replay accounting properties', () => {
  test('property: partial entry and arbitrary partial exits conserve cash and inventory until exactly flat', () => {
    checkProperty(
      'partial-fill-conservation',
      fc.property(scenario, (input) => {
        const quantity = input.parts.reduce((total, part) => total + part, 0n)
        const opening = notional(quantity, input.entryPrice) + 1_000_000_000_000n
        const initial = Result.getOrThrow(createReplayLedger(String(opening)))
        const entry = makeFill(input.symbol, 'buy', quantity, input.entryPrice)
        let ledger = Result.getOrThrow(
          applyReplayFill(
            initial,
            entry,
            String(quantity + input.unfilledQuantity),
            intradayMomentumExecutionModel,
            input.feeMultiplier,
          ),
        )
        let balanceBeforeFees = opening - BigInt(entry.notionalMicros)
        let held = quantity
        let costBasis = BigInt(entry.notionalMicros)
        expect(ledger.cashMicros).toBe(String(balanceBeforeFees - BigInt(ledger.executionFeesMicros)))
        expect(ledger.positions).toEqual([
          { symbol: input.symbol, quantityMicros: String(held), costBasisMicros: String(costBasis) },
        ])
        expect(ledger.netRealizedPnlAfterCostsMicros).toBeNull()
        for (const part of input.parts) {
          const previous = ledger
          const saved = JSON.stringify(previous)
          const exit = makeFill(input.symbol, 'sell', part, input.exitPrice)
          ledger = Result.getOrThrow(
            applyReplayFill(previous, exit, String(held), intradayMomentumExecutionModel, input.feeMultiplier),
          )
          balanceBeforeFees += BigInt(exit.notionalMicros)
          const numerator = costBasis * part
          const soldBasis = numerator / held + ((numerator % held) * 2n >= held ? 1n : 0n)
          costBasis -= soldBasis
          held -= part
          expect(ledger.cashMicros).toBe(String(balanceBeforeFees - BigInt(ledger.executionFeesMicros)))
          expect(BigInt(ledger.executionFeesMicros)).toBeGreaterThanOrEqual(BigInt(previous.executionFeesMicros))
          expect(ledger.positions).toEqual(
            held === 0n
              ? []
              : [{ symbol: input.symbol, quantityMicros: String(held), costBasisMicros: String(costBasis) }],
          )
          expect(ledger.netRealizedPnlAfterCostsMicros).toBe(
            held === 0n ? String(BigInt(ledger.cashMicros) - opening) : null,
          )
          expect(ledger.fills).toEqual([...previous.fills, exit])
          expect(JSON.stringify(previous)).toBe(saved)
        }
        expect(initial.positions).toEqual([])
        expect(initial.cashMicros).toBe(String(opening))
        expect(ledger.positions).toEqual([])
      }),
    )
  })

  test('property: a one-micro oversell or forged notional cannot alter the ledger', () => {
    checkProperty(
      'partial-fill-boundaries',
      fc.property(scenario, (input) => {
        const quantity = input.parts.reduce((total, part) => total + part, 0n)
        const initial = Result.getOrThrow(createReplayLedger('1000000000000000'))
        const entry = makeFill(input.symbol, 'buy', quantity, input.entryPrice)
        const ledger = Result.getOrThrow(
          applyReplayFill(
            initial,
            entry,
            String(quantity + input.unfilledQuantity),
            intradayMomentumExecutionModel,
            input.feeMultiplier,
          ),
        )
        const saved = JSON.stringify(ledger)
        const oversell = makeFill(input.symbol, 'sell', quantity + 1n, input.exitPrice)
        expect(
          applyReplayFill(ledger, oversell, String(quantity + 1n), intradayMomentumExecutionModel, input.feeMultiplier),
        ).toMatchObject({
          _tag: 'Failure',
          failure: { _tag: 'IntradayReplayLedgerOversell', positionQuantityMicros: String(quantity) },
        })
        const exit = makeFill(input.symbol, 'sell', quantity, input.exitPrice)
        for (const delta of [-1n, 1n])
          expect(
            applyReplayFill(
              ledger,
              { ...exit, notionalMicros: String(BigInt(exit.notionalMicros) + delta) },
              String(quantity),
              intradayMomentumExecutionModel,
              input.feeMultiplier,
            ),
          ).toMatchObject({
            _tag: 'Failure',
            failure: { _tag: 'InvalidIntradayReplayLedger', reason: 'notional-mismatch' },
          })
        expect(JSON.stringify(ledger)).toBe(saved)
      }),
    )
  })
})
