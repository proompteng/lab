import { Result } from 'effect'

import { Pipeable } from './pipeable'

export type UnsignedRoundHalfUpFailure =
  | {
      readonly _tag: 'NegativeUnsignedRoundHalfUpNumerator'
      readonly numerator: bigint
      readonly denominator: bigint
      readonly minimumNumerator: 0n
    }
  | {
      readonly _tag: 'NonPositiveUnsignedRoundHalfUpDenominator'
      readonly numerator: bigint
      readonly denominator: bigint
      readonly minimumDenominator: 1n
    }

const roundUnsignedHalfUpDataFirst = (
  numerator: bigint,
  denominator: bigint,
): Result.Result<bigint, UnsignedRoundHalfUpFailure> => {
  if (numerator < 0n) {
    return Result.fail({
      _tag: 'NegativeUnsignedRoundHalfUpNumerator',
      numerator,
      denominator,
      minimumNumerator: 0n,
    })
  }
  if (denominator <= 0n) {
    return Result.fail({
      _tag: 'NonPositiveUnsignedRoundHalfUpDenominator',
      numerator,
      denominator,
      minimumDenominator: 1n,
    })
  }
  return Result.succeed((numerator + denominator / 2n) / denominator)
}

export const roundUnsignedHalfUp = Pipeable.dual(2, roundUnsignedHalfUpDataFirst)
