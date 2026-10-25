import { cryptoMaximumTakerFeeBps } from './broker/crypto-fees'
import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { MICROS, type ExecutionModelFailure } from './strategy/execution-model/model'
import { intradayExecutionModel } from './strategy/intraday-market'
import { saleCostBasisMicros } from './strategy/execution-model/cash'
import { calculateSessionFees } from './strategy/execution-model/fees'
import { desiredQuantityAtoms, notionalMicros, referencePriceMicros } from './strategy/execution-model/fixed-point'

import { CycleExecutionModelSchema, ExecutionModelSchema } from './execution-model-contract'
import { strictParseOptions } from './schemas'
import { intradayMomentumExecutionModel } from './strategy/intraday-momentum/protocol'

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

describe('explicit execution model', () => {
  test('decodes retained daily execution models without treating them as the active model', () => {
    const decode = Schema.decodeUnknownResult(ExecutionModelSchema, strictParseOptions)
    const historical = {
      ...intradayExecutionModel,
      schemaVersion: 'bayn.execution-model.v3',
      venue: 'alpaca-us-equity',
      assetClass: 'us-equity',
      order: {
        type: 'market',
        timeInForce: 'day',
        extendedHours: false,
        planAfter: 'signal-session-finalized',
        submitAfter: 'plan-committed',
        submitBefore: 'fixed-pre-open-cutoff',
        planningPriceReference: 'signal-session-close',
        planningBrokerStateReference: 'reconciled-pre-plan-broker-state',
        fillPriceReference: 'next-session-open',
        buyingPowerPolicy: 'pre-submit-cash-without-sell-proceeds',
        submissionCutoffLeadMinutes: 15,
      },
      precision: { ...intradayExecutionModel.precision, quantityIncrementAtoms: '1000' },
    }
    expect(Result.isSuccess(decode(historical))).toBeTrue()
    expect(
      Result.isSuccess(decode({ ...historical, schemaVersion: 'bayn.execution-model.v2', venue: 'alpaca-paper' })),
    ).toBeTrue()
    expect(Result.isFailure(decode({ ...historical, venue: 'alpaca-paper' }))).toBeTrue()
    expect(intradayExecutionModel.schemaVersion).toBe('bayn.execution-model.v6')
  })

  test('binds rolling intraday execution to session-relative warmup and cutoff boundaries', () => {
    const decodeExecutionModel = Schema.decodeUnknownResult(ExecutionModelSchema, strictParseOptions)
    const decodeCycleExecutionModel = Schema.decodeUnknownResult(CycleExecutionModelSchema, strictParseOptions)

    expect(intradayMomentumExecutionModel).toMatchObject({
      schemaVersion: 'bayn.execution-model.v6',
      venue: 'alpaca-cash-spot',
      order: {
        type: 'limit',
        timeInForce: 'asset-session',
        planAfter: 'verified-intraday-window',
        warmupAfterOpenMs: 0,
        submissionCutoffBeforeCloseMs: 300_000,
      },
      precision: { quantityIncrementAtoms: '1' },
    })
    expect(Result.isSuccess(decodeExecutionModel(intradayMomentumExecutionModel))).toBeTrue()
    expect(Result.isSuccess(decodeCycleExecutionModel(intradayMomentumExecutionModel))).toBeTrue()
    expect(
      Result.isFailure(
        decodeExecutionModel({
          ...intradayMomentumExecutionModel,
          order: {
            ...intradayMomentumExecutionModel.order,
            warmupAfterOpenMs: 5 * 60 * 60 * 1_000,
            submissionCutoffBeforeCloseMs: 200 * 60 * 1_000,
          },
        }),
      ),
    ).toBeTrue()
  })

  test('admits exact regular-session boundaries and rejects offsets outside the session', () => {
    const decode = Schema.decodeUnknownResult(CycleExecutionModelSchema, strictParseOptions)
    const model = {
      ...intradayMomentumExecutionModel,
      order: { ...intradayMomentumExecutionModel.order, warmupAfterOpenMs: 0, submissionCutoffBeforeCloseMs: 0 },
    }
    expect(Result.isSuccess(decode(model))).toBeTrue()
    for (const field of ['warmupAfterOpenMs', 'submissionCutoffBeforeCloseMs']) {
      for (const offset of [-1, 0.5, 86_400_001]) {
        expect(Result.isFailure(decode({ ...model, order: { ...model.order, [field]: offset } }))).toBeTrue()
      }
    }
  })

  test('preserves half-up arithmetic and its exact failure data', () => {
    const u128Maximum = (1n << 128n) - 1n

    expect(success(referencePriceMicros(100.12345, intradayExecutionModel))).toBe(100_123_500n)
    expect(success(notionalMicros(500_000_000n, 100_000_001n))).toBe(50_000_001n)
    expect(success(saleCostBasisMicros(1n, 1n, 2n))).toBe(1n)
    expect(success(notionalMicros(u128Maximum * 1000n, 1_000_001n))).toBe(
      340_282_707_203_305_384_401_838_070_806_375_643_223n,
    )
    expect(failure(notionalMicros(-1n, 1n))).toEqual({
      _tag: 'NegativeUnsignedRoundHalfUpNumerator',
      numerator: -1n,
      denominator: 1_000_000_000n,
      minimumNumerator: 0n,
    })
  })

  test('aggregates regulatory fees by session, applies caps, and rounds each type upward to a cent', () => {
    const fees = success(
      calculateSessionFees(
        [
          { symbol: 'NVDA', side: 'buy', quantityAtoms: 1000000000n, notionalMicros: 100_000_000n },
          { symbol: 'NVDA', side: 'sell', quantityAtoms: 10000000000n, notionalMicros: 1_000_000_000n },
        ],
        intradayExecutionModel,
        MICROS,
        cryptoMaximumTakerFeeBps,
      ),
    )
    expect(fees).toEqual({
      commissionMicros: 0n,
      secMicros: 30_000n,
      tafMicros: 10_000n,
      catMicros: 10_000n,
      cryptoMicros: 0n,
      cashMicros: 50_000n,
      totalMicros: 50_000n,
    })

    const capped = success(
      calculateSessionFees(
        [
          {
            symbol: 'NVDA',
            side: 'sell',
            quantityAtoms: 100000000000n * MICROS,
            notionalMicros: 100_000_000n * MICROS,
          },
        ],
        intradayExecutionModel,
        MICROS,
        cryptoMaximumTakerFeeBps,
      ),
    )
    expect(capped.tafMicros).toBe(9_790_000n)
  })

  test('accepts exact twelve-decimal weights despite binary floating-point representation', () => {
    expect(
      success(desiredQuantityAtoms(1_000n * MICROS, 0.123_456_789_012, 100n * MICROS, intradayExecutionModel)),
    ).toBe(1234567890n)
    expect(
      failure(desiredQuantityAtoms(1_000n * MICROS, 0.123_456_789_012_3, 100n * MICROS, intradayExecutionModel)),
    ).toMatchObject({
      _tag: 'InvalidFixedPointNumber',
      field: 'target weight',
      reason: 'precision-exceeded',
    })
  })

  test('returns discriminated failures for invalid prices, fees and cost basis', () => {
    expect(failure(referencePriceMicros(Number.NaN, intradayExecutionModel))).toMatchObject({
      _tag: 'InvalidReferencePrice',
      reason: 'not-positive',
    })
    expect(failure(calculateSessionFees([], intradayExecutionModel, 0n, cryptoMaximumTakerFeeBps))).toMatchObject({
      _tag: 'InvalidFeeCostMultiplier',
    })
    expect(failure(saleCostBasisMicros(100n, 2n, 1n))).toMatchObject({
      _tag: 'InvalidSaleCostBasis',
      reason: 'quantity-exceeds-position',
    })
  })
})
