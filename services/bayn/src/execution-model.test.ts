import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import {
  MICROS,
  accrueCashYield,
  calculateSessionFees,
  defaultExecutionModel,
  desiredQuantityMicros,
  elapsedCalendarDays,
  makeFillTerms,
  makeOrderOutcome,
  notionalMicros,
  referencePriceMicros,
  saleCostBasisMicros,
  scaleQuantityMicros,
  type ExecutionModelFailure,
} from './execution-model'

const success = <A>(result: Result.Result<A, ExecutionModelFailure>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) throw new Error(result.failure._tag)
  return result.success
}

const failure = <A>(result: Result.Result<A, ExecutionModelFailure>): ExecutionModelFailure => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) throw new Error('expected execution-model failure')
  return result.failure
}

describe('explicit paper execution model', () => {
  test('rounds price adversely and separates spread from slippage', () => {
    const reference = success(referencePriceMicros(100, defaultExecutionModel))
    const buy = success(makeFillTerms('buy', MICROS, reference, defaultExecutionModel, MICROS))
    const sell = success(makeFillTerms('sell', MICROS, reference, defaultExecutionModel, MICROS))

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
    expect(success(referencePriceMicros(100.123456, defaultExecutionModel))).toBe(100_123_500n)
  })

  test('preserves half-up arithmetic and its exact failure data', () => {
    const u128Maximum = (1n << 128n) - 1n

    expect(success(referencePriceMicros(100.12345, defaultExecutionModel))).toBe(100_123_500n)
    expect(success(notionalMicros(500_000n, 100_000_001n))).toBe(50_000_001n)
    expect(success(saleCostBasisMicros(1n, 1n, 2n))).toBe(1n)
    expect(success(notionalMicros(u128Maximum, 1_000_001n))).toBe(340_282_707_203_305_384_401_838_070_806_375_643_223n)
    expect(failure(notionalMicros(-1n, 1n))).toEqual({
      _tag: 'NegativeUnsignedRoundHalfUpNumerator',
      numerator: -1n,
      denominator: MICROS,
      minimumNumerator: 0n,
    })
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

    expect(success(makeOrderOutcome({ ...input, model: fullModel }))).toMatchObject({
      filledQuantityMicros: 2_000_000n,
      status: 'filled',
      unfilledRemainder: 'none',
    })
    const partial = success(makeOrderOutcome({ ...input, model: partialModel }))
    expect(partial).toEqual(success(makeOrderOutcome({ ...input, model: partialModel })))
    expect(partial).toMatchObject({
      filledQuantityMicros: 1_000_000n,
      status: 'partially-filled',
      unfilledRemainder: 'canceled',
    })
    expect(
      success(
        makeOrderOutcome({
          ...input,
          requestedQuantityMicros: 5_000n,
          referencePriceMicros: 100_000_000n,
          model: fullModel,
        }),
      ),
    ).toMatchObject({ status: 'rejected', rejectionReason: 'below-minimum-buy-notional' })
  })

  test('aggregates regulatory fees by session, applies caps, and rounds each type upward to a cent', () => {
    const fees = success(
      calculateSessionFees(
        [
          { side: 'buy', quantityMicros: 1_000_000n, notionalMicros: 100_000_000n },
          { side: 'sell', quantityMicros: 10_000_000n, notionalMicros: 1_000_000_000n },
        ],
        defaultExecutionModel,
        MICROS,
      ),
    )
    expect(fees).toEqual({
      commissionMicros: 0n,
      secMicros: 30_000n,
      tafMicros: 10_000n,
      catMicros: 10_000n,
      totalMicros: 50_000n,
    })

    const capped = success(
      calculateSessionFees(
        [{ side: 'sell', quantityMicros: 100_000_000n * MICROS, notionalMicros: 100_000_000n * MICROS }],
        defaultExecutionModel,
        MICROS,
      ),
    )
    expect(capped.tafMicros).toBe(9_790_000n)
  })

  test('keeps cash yield explicit for both zero and nonzero rates', () => {
    expect(success(accrueCashYield(1_000n * MICROS, 3, defaultExecutionModel))).toBe(0n)
    const yielding = {
      ...defaultExecutionModel,
      cash: { ...defaultExecutionModel.cash, annualYieldBps: 500 },
    }
    expect(success(accrueCashYield(1_000n * MICROS, 3, yielding))).toBe(410_958n)
  })

  test('accepts exact twelve-decimal weights despite binary floating-point representation', () => {
    expect(
      success(desiredQuantityMicros(1_000n * MICROS, 0.123_456_789_012, 100n * MICROS, defaultExecutionModel)),
    ).toBe(1_234_567n)
    expect(
      failure(desiredQuantityMicros(1_000n * MICROS, 0.123_456_789_012_3, 100n * MICROS, defaultExecutionModel)),
    ).toMatchObject({
      _tag: 'InvalidFixedPointNumber',
      field: 'target weight',
      reason: 'precision-exceeded',
    })
  })

  test('doubles declared execution costs without changing fill selection', () => {
    const identity = { decisionId: 'a'.repeat(64), symbol: 'SPY', side: 'sell' }
    const outcome = success(
      makeOrderOutcome({
        identity,
        side: 'sell',
        requestedQuantityMicros: 2_000_000n,
        referencePriceMicros: 100_000_000n,
        model: defaultExecutionModel,
      }),
    )
    const base = success(
      makeFillTerms('sell', outcome.filledQuantityMicros, 100_000_000n, defaultExecutionModel, MICROS),
    )
    const doubled = success(
      makeFillTerms('sell', outcome.filledQuantityMicros, 100_000_000n, defaultExecutionModel, 2n * MICROS),
    )

    expect(doubled.spreadCostMicros).toBe(2n * base.spreadCostMicros)
    expect(doubled.slippageCostMicros).toBe(2n * base.slippageCostMicros)
    expect(
      success(
        makeOrderOutcome({
          identity,
          side: 'sell',
          requestedQuantityMicros: 2_000_000n,
          referencePriceMicros: 100_000_000n,
          model: defaultExecutionModel,
        }),
      ),
    ).toEqual(outcome)
  })

  test('returns discriminated failures for every invalid public decision family', () => {
    expect(failure(referencePriceMicros(Number.NaN, defaultExecutionModel))).toMatchObject({
      _tag: 'InvalidReferencePrice',
      reason: 'not-positive',
    })
    expect(failure(makeFillTerms('buy', 0n, MICROS, defaultExecutionModel, MICROS))).toMatchObject({
      _tag: 'InvalidFillTerms',
      reason: 'invalid-quantity-or-price',
    })
    expect(failure(calculateSessionFees([], defaultExecutionModel, 0n))).toMatchObject({
      _tag: 'InvalidFeeCostMultiplier',
    })
    expect(failure(accrueCashYield(-1n, 1, defaultExecutionModel))).toMatchObject({
      _tag: 'InvalidCashYield',
      reason: 'negative-cash',
    })
    expect(failure(elapsedCalendarDays('2026-01-02', '2026-01-01'))).toEqual({
      _tag: 'InvalidCashAccrualPeriod',
      from: '2026-01-02',
      to: '2026-01-01',
    })
    expect(failure(saleCostBasisMicros(100n, 2n, 1n))).toMatchObject({
      _tag: 'InvalidSaleCostBasis',
      reason: 'quantity-exceeds-position',
    })
    expect(failure(scaleQuantityMicros(1n, 1_000_001n, defaultExecutionModel))).toMatchObject({
      _tag: 'InvalidQuantityScale',
    })
  })

  test('retains canonicalization failure evidence without throwing', () => {
    const partialModel = {
      ...defaultExecutionModel,
      partialFills: { ...defaultExecutionModel.partialFills, probabilityPpm: 1_000_000 },
    }
    const result = makeOrderOutcome({
      identity: { invalid: 1n },
      side: 'sell',
      requestedQuantityMicros: MICROS,
      referencePriceMicros: 100n * MICROS,
      model: partialModel,
    })

    expect(failure(result)).toMatchObject({
      _tag: 'OrderOutcomeCanonicalizationFailed',
      identity: { invalid: 1n },
    })
  })
})
