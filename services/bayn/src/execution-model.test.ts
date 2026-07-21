import { describe, expect, test } from 'bun:test'

import {
  MICROS,
  accrueCashYield,
  calculateSessionFees,
  defaultExecutionModel,
  makeFillTerms,
  makeOrderOutcome,
  referencePriceMicros,
} from './execution-model'

describe('explicit paper execution model', () => {
  test('rounds price adversely and separates spread from slippage', () => {
    const reference = referencePriceMicros(100, defaultExecutionModel)
    const buy = makeFillTerms('buy', MICROS, reference, defaultExecutionModel, MICROS)
    const sell = makeFillTerms('sell', MICROS, reference, defaultExecutionModel, MICROS)

    expect(buy).toMatchObject({
      referencePriceMicros: 100_000_000n,
      fillPriceMicros: 100_050_000n,
      spreadCostMicros: 25_000n,
      slippageCostMicros: 25_000n,
    })
    expect(sell).toMatchObject({
      referencePriceMicros: 100_000_000n,
      fillPriceMicros: 99_950_000n,
      spreadCostMicros: 25_000n,
      slippageCostMicros: 25_000n,
    })
    expect(referencePriceMicros(100.123456, defaultExecutionModel)).toBe(100_123_500n)
  })

  test('makes full, partial, and rejected outcomes deterministic', () => {
    const fullModel = {
      ...defaultExecutionModel,
      partialFills: { ...defaultExecutionModel.partialFills, probabilityPpm: 0 },
    }
    const partialModel = {
      ...defaultExecutionModel,
      partialFills: { ...defaultExecutionModel.partialFills, probabilityPpm: 1_000_000 },
    }
    const input = {
      identity: { decisionId: 'a'.repeat(64), symbol: 'SPY', side: 'buy' },
      side: 'buy' as const,
      requestedQuantityMicros: 2_000_000n,
      referencePriceMicros: 100_000_000n,
    }

    expect(makeOrderOutcome({ ...input, model: fullModel })).toMatchObject({
      filledQuantityMicros: 2_000_000n,
      status: 'filled',
      unfilledRemainder: 'none',
    })
    const partial = makeOrderOutcome({ ...input, model: partialModel })
    expect(partial).toEqual(makeOrderOutcome({ ...input, model: partialModel }))
    expect(partial).toMatchObject({
      filledQuantityMicros: 1_000_000n,
      status: 'partially-filled',
      unfilledRemainder: 'canceled',
    })
    expect(
      makeOrderOutcome({
        ...input,
        requestedQuantityMicros: 5_000n,
        referencePriceMicros: 100_000_000n,
        model: fullModel,
      }),
    ).toMatchObject({ status: 'rejected', rejectionReason: 'below-minimum-buy-notional' })
  })

  test('aggregates regulatory fees by session, applies caps, and rounds each type upward to a cent', () => {
    const fees = calculateSessionFees(
      [
        { side: 'buy', quantityMicros: 1_000_000n, notionalMicros: 100_000_000n },
        { side: 'sell', quantityMicros: 10_000_000n, notionalMicros: 1_000_000_000n },
      ],
      defaultExecutionModel,
      MICROS,
    )
    expect(fees).toEqual({
      commissionMicros: 0n,
      secMicros: 30_000n,
      tafMicros: 10_000n,
      catMicros: 10_000n,
      totalMicros: 50_000n,
    })

    const capped = calculateSessionFees(
      [{ side: 'sell', quantityMicros: 100_000_000n * MICROS, notionalMicros: 100_000_000n * MICROS }],
      defaultExecutionModel,
      MICROS,
    )
    expect(capped.tafMicros).toBe(9_790_000n)
  })

  test('keeps cash yield explicit for both zero and nonzero rates', () => {
    expect(accrueCashYield(1_000n * MICROS, 3, defaultExecutionModel)).toBe(0n)
    const yielding = {
      ...defaultExecutionModel,
      cash: { ...defaultExecutionModel.cash, annualYieldBps: 500 },
    }
    expect(accrueCashYield(1_000n * MICROS, 3, yielding)).toBe(410_958n)
  })

  test('doubles declared execution costs without changing fill selection', () => {
    const identity = { decisionId: 'a'.repeat(64), symbol: 'SPY', side: 'sell' }
    const outcome = makeOrderOutcome({
      identity,
      side: 'sell',
      requestedQuantityMicros: 2_000_000n,
      referencePriceMicros: 100_000_000n,
      model: defaultExecutionModel,
    })
    const base = makeFillTerms('sell', outcome.filledQuantityMicros, 100_000_000n, defaultExecutionModel, MICROS)
    const doubled = makeFillTerms(
      'sell',
      outcome.filledQuantityMicros,
      100_000_000n,
      defaultExecutionModel,
      2n * MICROS,
    )

    expect(doubled.spreadCostMicros).toBe(2n * base.spreadCostMicros)
    expect(doubled.slippageCostMicros).toBe(2n * base.slippageCostMicros)
    expect(
      makeOrderOutcome({
        identity,
        side: 'sell',
        requestedQuantityMicros: 2_000_000n,
        referencePriceMicros: 100_000_000n,
        model: defaultExecutionModel,
      }),
    ).toEqual(outcome)
  })
})
