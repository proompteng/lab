import { Clock, DateTime, Effect, Option, Result } from 'effect'

export type UtcEpochMillisFailure =
  | {
      readonly _tag: 'UtcEpochMillisNotSafeInteger'
      readonly epochMillis: number
    }
  | {
      readonly _tag: 'UtcEpochMillisOutOfRange'
      readonly epochMillis: number
    }

export const utcInstantFromEpochMillisResult = (epochMillis: number): Result.Result<string, UtcEpochMillisFailure> => {
  if (!Number.isSafeInteger(epochMillis)) {
    return Result.fail({ _tag: 'UtcEpochMillisNotSafeInteger', epochMillis })
  }
  return Option.match(DateTime.make(epochMillis), {
    onNone: () => Result.fail({ _tag: 'UtcEpochMillisOutOfRange', epochMillis }),
    onSome: (dateTime) => Result.succeed(DateTime.formatIso(dateTime)),
  })
}

export const utcInstantFromEpochMillis = (epochMillis: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(epochMillis))

export const utcDateFromEpochMillis = (epochMillis: number): string =>
  DateTime.formatIsoDate(DateTime.makeUnsafe(epochMillis))

export const nativeWallClock = 'effect.Clock.currentTimeMillis'

export const currentUtcInstant = Clock.currentTimeMillis.pipe(Effect.map(utcInstantFromEpochMillis))

export const currentUtcDate = Clock.currentTimeMillis.pipe(Effect.map(utcDateFromEpochMillis))

const accountDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
export const accountTradingDate = (observedAt: string): string => accountDateFormatter.format(new Date(observedAt))
