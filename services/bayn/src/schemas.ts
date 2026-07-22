import { Schema } from 'effect'

export const strictParseOptions = { onExcessProperty: 'error' } as const

const isIsoDate = (value: string): value is `${number}-${number}-${number}` => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const isUtcInstant = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

const isUtcOrderTimestamp = (value: string): boolean => {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{9})Z$/.exec(value)
  if (match === null) return false
  const date = new Date(`${match[1]}.${match[2].slice(0, 3)}Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 19) === match[1]
}

export const StrictNonEmptyStringSchema = Schema.String.check(
  Schema.makeFilter((value: string) => value.length > 0 && value.trim() === value, {
    expected: 'a non-empty string without surrounding whitespace',
  }),
)
export const TrimmedNonEmptyStringSchema = Schema.Trim.check(Schema.isMinLength(1))
export const IsoDateSchema = Schema.String.pipe(Schema.refine(isIsoDate, { expected: 'a valid ISO date (YYYY-MM-DD)' }))
export type IsoDate = typeof IsoDateSchema.Type
export const UtcInstantSchema = Schema.String.check(
  Schema.makeFilter(isUtcInstant, { expected: 'a canonical UTC instant (YYYY-MM-DDTHH:mm:ss.sssZ)' }),
)
export const UtcOrderTimestampSchema = Schema.String.check(
  Schema.makeFilter(isUtcOrderTimestamp, {
    expected: 'a canonical UTC ordering timestamp (YYYY-MM-DDTHH:mm:ss.nnnnnnnnnZ)',
  }),
)
export const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const ImageDigestSchema = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
export const ImageRepositorySchema = Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/))
export const SourceRevisionSchema = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/))
export const GitSourceRevisionSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
export const SymbolSchema = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9.-]{0,15}$/))
// The upstream Signal row contract historically accepts one fewer trailing character than Bayn's domain contract.
export const SignalRowSymbolSchema = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9.-]{0,14}$/))
export const PositiveIntegerSchema = Schema.Int.check(Schema.isGreaterThan(0))
export const NonNegativeIntegerSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const PositiveFiniteSchema = Schema.Finite.check(Schema.isGreaterThan(0))
export const NonNegativeFiniteSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
export const UnitIntervalSchema = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
export const DigitsSchema = Schema.String.check(Schema.isPattern(/^\d+$/))
export const UnsignedMicrosSchema = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/))
export const PositiveMicrosSchema = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/))
export const SignedMicrosSchema = Schema.String.check(Schema.isPattern(/^-?\d+$/))
