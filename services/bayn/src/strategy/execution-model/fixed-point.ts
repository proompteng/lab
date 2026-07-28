import { Result, pipe } from 'effect'

import type { ExecutionModel } from '../../types'
import { roundUnsignedHalfUp } from '../../unsigned-round-half-up'
import { MICROS, WEIGHT_SCALE, type ExecutionModelFailure } from './model'

export type ExecutionResult<A> = Result.Result<A, ExecutionModelFailure>

export const fail = <A>(failure: ExecutionModelFailure): ExecutionResult<A> => Result.fail(failure)

export const ensureUnsigned = (value: string, field: string, minimum = 0n): ExecutionResult<bigint> => {
  if (!/^[0-9]+$/.test(value)) {
    return fail({ _tag: 'InvalidUnsignedInteger', field, value, minimum })
  }
  const parsed = BigInt(value)
  return parsed < minimum ? fail({ _tag: 'InvalidUnsignedInteger', field, value, minimum }) : Result.succeed(parsed)
}

export const scaledNumber = (value: number, field: string, scale = Number(MICROS)): ExecutionResult<bigint> => {
  if (!Number.isFinite(value)) {
    return fail({ _tag: 'InvalidFixedPointNumber', field, value, scale, reason: 'not-finite' })
  }
  if (value < 0) {
    return fail({ _tag: 'InvalidFixedPointNumber', field, value, scale, reason: 'negative' })
  }
  const scaled = value * scale
  const rounded = Math.round(scaled)
  const floatingPointTolerance = Math.max(1e-9, Number.EPSILON * Math.abs(scaled) * 4)
  return !Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > floatingPointTolerance
    ? fail({ _tag: 'InvalidFixedPointNumber', field, value, scale, reason: 'precision-exceeded' })
    : Result.succeed(BigInt(rounded))
}

export const integerNumber = (
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): ExecutionResult<bigint> =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? Result.succeed(BigInt(value))
    : fail({ _tag: 'InvalidIntegerNumber', field, value, minimum, maximum })

export const ceilDiv = (numerator: bigint, denominator: bigint): ExecutionResult<bigint> => {
  if (numerator < 0n || denominator <= 0n) {
    return fail({
      _tag: 'InvalidCeilingDivision',
      numerator,
      denominator,
      minimumNumerator: 0n,
      minimumDenominator: 1n,
    })
  }
  return Result.succeed(numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n)
}

export const roundDiv = (numerator: bigint, denominator: bigint): ExecutionResult<bigint> =>
  roundUnsignedHalfUp(numerator, denominator)

export const quantizeDown = (value: bigint, increment: bigint): ExecutionResult<bigint> =>
  value < 0n || increment <= 0n
    ? fail({
        _tag: 'InvalidQuantization',
        operation: 'down',
        value,
        increment,
        minimumValue: 0n,
        minimumIncrement: 1n,
      })
    : Result.succeed((value / increment) * increment)

export const quantizeUp = (value: bigint, increment: bigint): ExecutionResult<bigint> =>
  pipe(
    ceilDiv(value, increment),
    Result.map((quotient) => quotient * increment),
  )

export const quantizeNearest = (value: bigint, increment: bigint): ExecutionResult<bigint> =>
  pipe(
    roundDiv(value, increment),
    Result.map((quotient) => quotient * increment),
  )

export const numberToMicros = (value: number, field = 'value'): ExecutionResult<bigint> => {
  const scale = Number(MICROS)
  if (!Number.isFinite(value)) {
    return fail({ _tag: 'InvalidFixedPointNumber', field, value, scale, reason: 'not-finite' })
  }
  if (value < 0) {
    return fail({ _tag: 'InvalidFixedPointNumber', field, value, scale, reason: 'negative' })
  }
  const scaled = Math.round(value * scale)
  return Number.isSafeInteger(scaled)
    ? Result.succeed(BigInt(scaled))
    : fail({ _tag: 'InvalidFixedPointNumber', field, value, scale, reason: 'precision-exceeded' })
}

export const microsToNumber = (value: bigint): number => Number(value) / Number(MICROS)

export const referencePriceMicros = (price: number, model: ExecutionModel): ExecutionResult<bigint> => {
  if (!Number.isFinite(price) || price <= 0) {
    return fail({ _tag: 'InvalidReferencePrice', price, reason: 'not-positive' })
  }
  return pipe(
    Result.all({
      increment: ensureUnsigned(model.precision.priceIncrementMicros, 'price increment', 1n),
      priceMicros: numberToMicros(price, 'reference price'),
    }),
    Result.flatMap(({ increment, priceMicros }) => quantizeNearest(priceMicros, increment)),
    Result.flatMap((quantized) =>
      quantized === 0n
        ? fail({ _tag: 'InvalidReferencePrice', price, reason: 'rounded-to-zero' })
        : Result.succeed(quantized),
    ),
  )
}

export const notionalMicros = (quantityMicros: bigint, priceMicros: bigint): ExecutionResult<bigint> =>
  roundDiv(quantityMicros * priceMicros, MICROS)

export const desiredQuantityMicros = (
  equityMicros: bigint,
  weight: number,
  priceMicros: bigint,
  model: Pick<ExecutionModel, 'precision'>,
): ExecutionResult<bigint> => {
  if (equityMicros < 0n || priceMicros <= 0n) {
    return fail({
      _tag: 'InvalidDesiredQuantity',
      equityMicros,
      weight,
      priceMicros,
      reason: 'invalid-equity-or-price',
    })
  }
  return pipe(
    scaledNumber(weight, 'target weight', Number(WEIGHT_SCALE)),
    Result.flatMap((weightUnits) => {
      if (weightUnits > WEIGHT_SCALE) {
        return fail({
          _tag: 'InvalidDesiredQuantity',
          equityMicros,
          weight,
          priceMicros,
          reason: 'weight-exceeds-one',
        })
      }
      return pipe(
        ensureUnsigned(model.precision.quantityIncrementMicros, 'quantity increment', 1n),
        Result.flatMap((increment) => {
          const raw = (equityMicros * weightUnits * MICROS) / (WEIGHT_SCALE * priceMicros)
          return quantizeDown(raw, increment)
        }),
      )
    }),
  )
}
