import { Result, pipe } from 'effect'

import type { ExecutionModel } from '../../execution-model-contract'
import { ceilDiv, ensureUnsigned, fail, scaledNumber, type ExecutionResult } from './fixed-point'
import { BPS, MICROS } from './model'
import { Pipeable } from '../../pipeable'

export interface FeeInput {
  readonly side: 'buy' | 'sell'
  readonly quantityMicros: bigint
  readonly notionalMicros: bigint
}

export interface FeeBreakdown {
  readonly commissionMicros: bigint
  readonly secMicros: bigint
  readonly tafMicros: bigint
  readonly catMicros: bigint
  readonly totalMicros: bigint
}

const roundedFee = (numerator: bigint, denominator: bigint, increment: bigint): ExecutionResult<bigint> =>
  numerator === 0n
    ? Result.succeed(0n)
    : pipe(
        ceilDiv(numerator, denominator * increment),
        Result.map((quotient) => quotient * increment),
      )

const calculateSessionFeesDataFirst = (
  fills: readonly FeeInput[],
  model: ExecutionModel,
  costMultiplierMicros: bigint,
): ExecutionResult<FeeBreakdown> => {
  if (costMultiplierMicros <= 0n) {
    return fail({ _tag: 'InvalidFeeCostMultiplier', costMultiplierMicros, minimum: 1n })
  }
  const totalNotional = fills.reduce((sum, fill) => sum + fill.notionalMicros, 0n)
  const sellNotional = fills.reduce((sum, fill) => sum + (fill.side === 'sell' ? fill.notionalMicros : 0n), 0n)
  const totalQuantity = fills.reduce((sum, fill) => sum + fill.quantityMicros, 0n)

  return pipe(
    Result.all({
      rounding: ensureUnsigned(model.fees.roundingIncrementMicros, 'fee rounding increment', 1n),
      commissionRate: scaledNumber(model.fees.commissionBps, 'commission basis points'),
      secRate: scaledNumber(model.fees.secSellBps, 'SEC basis points'),
      tafRate: ensureUnsigned(model.fees.tafSellPerShareMicros, 'TAF share rate'),
      tafCap: ensureUnsigned(model.fees.tafMaximumPerOrderMicros, 'TAF order cap'),
      catRate: ensureUnsigned(model.fees.catPerShareMicros, 'CAT share rate'),
    }),
    Result.flatMap(({ rounding, commissionRate, secRate, tafRate, tafCap, catRate }) => {
      const tafNumerator = fills.reduce(
        (sum, fill) =>
          fill.side === 'sell'
            ? sum + (fill.quantityMicros * tafRate < tafCap * MICROS ? fill.quantityMicros * tafRate : tafCap * MICROS)
            : sum,
        0n,
      )
      return pipe(
        Result.all({
          commission: roundedFee(
            totalNotional * commissionRate * costMultiplierMicros,
            BPS * MICROS * MICROS,
            rounding,
          ),
          sec: roundedFee(sellNotional * secRate * costMultiplierMicros, BPS * MICROS * MICROS, rounding),
          taf: roundedFee(tafNumerator * costMultiplierMicros, MICROS * MICROS, rounding),
          cat: roundedFee(totalQuantity * catRate * costMultiplierMicros, MICROS * MICROS, rounding),
        }),
        Result.map(
          ({ commission, sec, taf, cat }): FeeBreakdown => ({
            commissionMicros: commission,
            secMicros: sec,
            tafMicros: taf,
            catMicros: cat,
            totalMicros: commission + sec + taf + cat,
          }),
        ),
      )
    }),
  )
}

export const calculateSessionFees = Pipeable.dual(3, calculateSessionFeesDataFirst)
