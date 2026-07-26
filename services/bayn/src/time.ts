import { Clock, DateTime, Effect, Option, pipe, Result } from 'effect'

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

export const addUtcDays = (date: string, days: number): string =>
  pipe(DateTime.makeUnsafe(`${date}T00:00:00.000Z`), DateTime.add({ days }), DateTime.formatIsoDate)

export const currentUtcInstant = Clock.currentTimeMillis.pipe(Effect.map(utcInstantFromEpochMillis))

export const currentUtcDate = Clock.currentTimeMillis.pipe(Effect.map(utcDateFromEpochMillis))
