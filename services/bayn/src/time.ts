import { Clock, DateTime, Effect, pipe } from 'effect'

export const utcInstantFromEpochMillis = (epochMillis: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(epochMillis))

export const utcDateFromEpochMillis = (epochMillis: number): string =>
  DateTime.formatIsoDate(DateTime.makeUnsafe(epochMillis))

export const addUtcDays = (date: string, days: number): string =>
  pipe(DateTime.makeUnsafe(`${date}T00:00:00.000Z`), DateTime.add({ days }), DateTime.formatIsoDate)

export const currentUtcInstant = Clock.currentTimeMillis.pipe(Effect.map(utcInstantFromEpochMillis))

export const currentUtcDate = Clock.currentTimeMillis.pipe(Effect.map(utcDateFromEpochMillis))
