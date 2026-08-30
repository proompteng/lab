import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { roundUnsignedHalfUp, type UnsignedRoundHalfUpFailure } from './unsigned-round-half-up'

const success = (result: Result.Result<bigint, UnsignedRoundHalfUpFailure>): bigint => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) throw new Error(result.failure._tag)
  return result.success
}

const failure = (result: Result.Result<bigint, UnsignedRoundHalfUpFailure>): UnsignedRoundHalfUpFailure => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) throw new Error(`unexpected rounded value ${result.success}`)
  return result.failure
}

const legacyRoundHalfUp = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator / 2n) / denominator

describe('unsigned round-half-up', () => {
  test('matches the prior formula and exact golden vectors', () => {
    const vectors: ReadonlyArray<readonly [bigint, bigint, bigint]> = [
      [0n, 1n, 0n],
      [4n, 10n, 0n],
      [5n, 10n, 1n],
      [6n, 10n, 1n],
      [14n, 10n, 1n],
      [15n, 10n, 2n],
      [1n, 3n, 0n],
      [2n, 3n, 1n],
    ]

    for (const [numerator, denominator, expected] of vectors) {
      expect(success(roundUnsignedHalfUp(numerator, denominator))).toBe(expected)
      expect(expected).toBe(legacyRoundHalfUp(numerator, denominator))
    }
  })

  test('preserves unbounded BigInt inputs and outputs', () => {
    const u128Maximum = (1n << 128n) - 1n
    const formerNumeratorBoundary = u128Maximum * u128Maximum
    const quotient = (1n << 512n) + 123n
    const evenDenominator = (1n << 320n) + 2n
    const oddDenominator = (1n << 320n) + 1n
    const vectors: ReadonlyArray<readonly [bigint, bigint, bigint]> = [
      [quotient * evenDenominator + evenDenominator / 2n, evenDenominator, quotient + 1n],
      [quotient * oddDenominator + oddDenominator / 2n, oddDenominator, quotient],
      [quotient * oddDenominator + oddDenominator / 2n + 1n, oddDenominator, quotient + 1n],
    ]

    for (const [numerator, denominator, expected] of vectors) {
      expect(numerator > formerNumeratorBoundary).toBe(true)
      expect(denominator > u128Maximum).toBe(true)
      expect(expected > u128Maximum).toBe(true)
      expect(success(roundUnsignedHalfUp(numerator, denominator))).toBe(expected)
      expect(expected).toBe(legacyRoundHalfUp(numerator, denominator))
    }
  })

  test('retains exact invalid numerator and denominator material', () => {
    expect(failure(roundUnsignedHalfUp(-1n, 7n))).toEqual({
      _tag: 'NegativeUnsignedRoundHalfUpNumerator',
      numerator: -1n,
      denominator: 7n,
      minimumNumerator: 0n,
    })
    expect(failure(roundUnsignedHalfUp(7n, 0n))).toEqual({
      _tag: 'NonPositiveUnsignedRoundHalfUpDenominator',
      numerator: 7n,
      denominator: 0n,
      minimumDenominator: 1n,
    })
    expect(failure(roundUnsignedHalfUp(7n, -1n))).toEqual({
      _tag: 'NonPositiveUnsignedRoundHalfUpDenominator',
      numerator: 7n,
      denominator: -1n,
      minimumDenominator: 1n,
    })
  })
})
