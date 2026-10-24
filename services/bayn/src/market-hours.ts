import { Data, Result, Schema } from 'effect'

import type { MarketCalendarObservation, MarketCalendarSession } from './broker/alpaca/model'
import { canonicalHashV1Result } from './hash'
import { equityDataSession } from './equity-hours'

export enum MarketSchedule {
  Sessions = 'SESSIONS',
  Continuous = 'CONTINUOUS',
}

export const ContinuousMarketHoursSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.continuous-market-hours.v1'),
  source: Schema.Literal('alpaca-crypto-us'),
  schedule: Schema.Literal(MarketSchedule.Continuous),
})

export interface ContinuousMarketHours {
  readonly schemaVersion: 'bayn.continuous-market-hours.v1'
  readonly source: 'alpaca-crypto-us'
  readonly schedule: MarketSchedule.Continuous
}

export const continuousMarketHours: ContinuousMarketHours = Object.freeze({
  schemaVersion: 'bayn.continuous-market-hours.v1',
  source: 'alpaca-crypto-us',
  schedule: MarketSchedule.Continuous,
})

export type MarketHours = MarketCalendarObservation | ContinuousMarketHours

export const isContinuousMarket = (hours: MarketHours): hours is ContinuousMarketHours =>
  hours.schemaVersion === 'bayn.continuous-market-hours.v1'

export interface TradingWindow {
  readonly schedule: MarketSchedule
  readonly date: string
  readonly openAt: string
  readonly entryCutoffAt: string
  readonly closeAt: string
}

export class MarketHoursError extends Data.TaggedError('MarketHoursError')<{
  readonly message: string
}> {}

export const tradingWindow = (
  hours: MarketHours,
  observedAt: string,
  policy: {
    readonly entryValidityMs: number
    readonly maximumHoldingMs: number
    readonly closeRecoveryMs: number
    readonly sessionEntryCutoffMs: number
  },
): Result.Result<TradingWindow | null, MarketHoursError> => {
  const now = Date.parse(observedAt)
  if (
    !Number.isSafeInteger(now) ||
    Object.values(policy).some((value) => !Number.isSafeInteger(value)) ||
    policy.entryValidityMs <= 0 ||
    policy.maximumHoldingMs <= 0 ||
    policy.closeRecoveryMs <= 0 ||
    policy.sessionEntryCutoffMs < 0
  )
    return Result.fail(new MarketHoursError({ message: 'invalid market clock or execution deadlines' }))
  if (isContinuousMarket(hours)) {
    const entryCutoff = now + policy.entryValidityMs
    return Result.succeed({
      schedule: MarketSchedule.Continuous,
      date: observedAt.slice(0, 10),
      openAt: observedAt,
      entryCutoffAt: new Date(entryCutoff).toISOString(),
      closeAt: new Date(entryCutoff + policy.maximumHoldingMs + policy.closeRecoveryMs).toISOString(),
    })
  }
  const session: MarketCalendarSession | undefined = hours.sessions.find(
    (entry) => now < Date.parse(entry.closeAt) - policy.sessionEntryCutoffMs,
  )
  return Result.succeed(
    session === undefined
      ? null
      : {
          schedule: MarketSchedule.Sessions,
          ...session,
          entryCutoffAt: new Date(Date.parse(session.closeAt) - policy.sessionEntryCutoffMs).toISOString(),
        },
  )
}

/** Continuous data has no exchange-session closing boundary. The observation is its finite upper bound. */
export const snapshotMarketCloseAt = (
  hours: MarketHours,
  sessionDate: string,
  observedAt: string,
): string | undefined =>
  isContinuousMarket(hours) ? observedAt : hours.sessions.find((entry) => entry.date === sessionDate)?.closeAt

export const continuousExecutionPolicy = Object.freeze({
  entryValidityMs: 60_000,
  maximumHoldingMs: 60 * 60_000,
  closeRecoveryMs: 3 * 60_000,
})

export const sameMarketHours = (left: MarketHours, right: MarketHours): boolean => {
  const a = canonicalHashV1Result(left),
    b = canonicalHashV1Result(right)
  return Result.isSuccess(a) && Result.isSuccess(b) && a.success === b.success
}
export const marketHoursAreCanonical = (hours: MarketHours): boolean => {
  if (isContinuousMarket(hours)) return sameMarketHours(hours, continuousMarketHours)
  const { normalizedResponseHash, ...material } = hours
  const hash = canonicalHashV1Result(material)
  return (
    Result.isSuccess(hash) &&
    hash.success === normalizedResponseHash &&
    hours.sessions.length === hours.providerSessions.length &&
    hours.providerSessions.every((provider, index) => {
      const session = equityDataSession(provider)
      const selected = hours.sessions[index]
      return (
        Result.isSuccess(session) &&
        selected !== undefined &&
        session.success.date === selected.date &&
        session.success.openAt === selected.openAt &&
        session.success.closeAt === selected.closeAt
      )
    })
  )
}

export const exchangeSessions = (hours: MarketHours): readonly MarketCalendarSession[] =>
  isContinuousMarket(hours) ? [] : hours.sessions

export const brokerCalendarResponseHash = (hours: MarketHours): string | null =>
  isContinuousMarket(hours) ? null : hours.normalizedResponseHash

/** Continuous markets use UTC days for observation cohorts, never as liquidation deadlines. */
export const observationSession = (hours: MarketHours, date: string): MarketCalendarSession | undefined =>
  isContinuousMarket(hours)
    ? { date, openAt: `${date}T00:00:00.000Z`, closeAt: new Date(Date.parse(date) + 86_400_000).toISOString() }
    : hours.sessions.find((session) => session.date === date)

export const executionCloseRecoveryExpiry = (calendar: MarketHours, observedAt: string): string | null => {
  const now = Date.parse(observedAt)
  if (!Number.isSafeInteger(now)) return null
  const deadline = now + continuousExecutionPolicy.closeRecoveryMs
  if (isContinuousMarket(calendar)) return new Date(deadline).toISOString()
  const session = calendar.providerSessions.find(
    (entry) => entry.sessionOpenAt <= observedAt && observedAt < entry.sessionCloseAt,
  )
  return session === undefined ? null : new Date(Math.min(deadline, Date.parse(session.sessionCloseAt))).toISOString()
}
