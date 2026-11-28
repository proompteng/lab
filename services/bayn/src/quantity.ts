import { Data, Result } from 'effect'

export const quantityScale = 1_000_000_000n

export class QuantityError extends Data.TaggedError('QuantityError')<{
  readonly value: string
  readonly reason: 'format' | 'precision'
}> {}

export const quantityFromDecimal = (value: string): Result.Result<bigint, QuantityError> => {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value)
  const whole = match?.[2]
  if (whole === undefined) return Result.fail(new QuantityError({ value, reason: 'format' }))
  const fraction = match?.[3] ?? ''
  if (/[1-9]/.test(fraction.slice(9))) return Result.fail(new QuantityError({ value, reason: 'precision' }))
  const absolute = BigInt(whole) * quantityScale + BigInt(fraction.slice(0, 9).padEnd(9, '0'))
  return Result.succeed(match?.[1] === '-' ? -absolute : absolute)
}

export const quantityToDecimal = (value: bigint): string => {
  const absolute = value < 0n ? -value : value
  const fraction = (absolute % quantityScale).toString().padStart(9, '0').replace(/0+$/, '')
  return `${value < 0n ? '-' : ''}${absolute / quantityScale}${fraction === '' ? '' : `.${fraction}`}`
}

export const quantityFromNumber = (value: number): Result.Result<bigint, QuantityError> => {
  const scaled = value * Number(quantityScale)
  const rounded = Math.round(scaled)
  return !Number.isFinite(value) ||
    !Number.isSafeInteger(rounded) ||
    Math.abs(scaled - rounded) > Math.max(1e-9, Number.EPSILON * Math.abs(scaled) * 4)
    ? Result.fail(new QuantityError({ value: String(value), reason: 'precision' }))
    : Result.succeed(BigInt(rounded))
}
