import { BigDecimal, Option, Schema } from 'effect'

export enum WebullSession {
  Pre = 'PRE',
  Regular = 'RTH',
  After = 'ATH',
}

export enum WebullRequestState {
  Observed = 'OBSERVED',
  Empty = 'EMPTY',
  Excluded = 'EXCLUDED',
  Omitted = 'OMITTED',
  Rejected = 'REJECTED',
}

export const WebullSymbolSchema = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value) => value.trim().length > 0 && !/\p{Cc}/u.test(value), {
    expected: 'a provider symbol without control characters',
  }),
)

export const WebullDecimalSchema = Schema.String.check(
  Schema.isPattern(/^\+?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/),
  Schema.isMaxLength(128),
  Schema.makeFilter(
    (value) => {
      const parsed = BigDecimal.fromString(value)
      return Option.isSome(parsed) && Math.abs(parsed.value.scale) <= 128
    },
    { expected: 'an exact decimal with scale at most 128' },
  ),
)

export const WebullPriceSchema = WebullDecimalSchema.check(
  Schema.makeFilter(
    (value) => {
      const parsed = BigDecimal.fromString(value)
      return Option.isSome(parsed) && BigDecimal.isPositive(parsed.value)
    },
    { expected: 'a positive price' },
  ),
)

export const webullPriceFields = {
  open: WebullPriceSchema,
  high: WebullPriceSchema,
  low: WebullPriceSchema,
  close: WebullPriceSchema,
  volume: WebullDecimalSchema,
}
