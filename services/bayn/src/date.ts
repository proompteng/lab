import { Schema } from 'effect'

const millisecondsPerDay = 86_400_000

const IsoDateString = Schema.isPattern(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)

export const IsoDateSchema = IsoDateString

export const elapsedDays = (from: string, to: string): number => {
  const fromTime = Date.parse(`${from}T00:00:00Z`)
  const toTime = Date.parse(`${to}T00:00:00Z`)
  return Math.max(0, (toTime - fromTime) / millisecondsPerDay)
}

export const isoDateFromMillis = (millis: number): string => new Date(millis).toISOString().slice(0, 10)

export const isoInstant = (millis: number): string => new Date(millis).toISOString()

export const compareIsoDate = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export const isDateValid = (value: string): boolean => {
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) && parsed >= 0
}
