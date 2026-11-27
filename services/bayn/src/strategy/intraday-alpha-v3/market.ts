import { Data, DateTime, Schema } from 'effect'

import { MarketCalendarProviderSessionSchema } from '../../broker/alpaca/model'
import { type EquityProviderSession } from '../../equity-hours'
import { PositiveMicrosSchema, UtcInstantSchema, strictParseOptions } from '../../schemas'
import { AlphaV3Engine, sipSymbols, type IntradayAlphaV3Policy } from './policy'

export const minuteMs = 60_000
const barMs = 5 * minuteMs

const SipSymbolSchema = Schema.Literals(sipSymbols)
const SipBarSchema = Schema.Struct({
  symbol: SipSymbolSchema,
  startAt: UtcInstantSchema,
  availableAt: UtcInstantSchema,
  openMicros: PositiveMicrosSchema,
  highMicros: PositiveMicrosSchema,
  lowMicros: PositiveMicrosSchema,
  closeMicros: PositiveMicrosSchema,
  vwapMicros: PositiveMicrosSchema,
  volume: PositiveMicrosSchema, // integer shares, not a monetary amount
})

export const AlphaV3MarketSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-alpha-sip-market.v1'),
  feed: Schema.Literal('alpaca-sip'),
  barMinutes: Schema.Literal(5),
  // The adapter retains each finalized bar and the time that exact value first became readable.
  session: MarketCalendarProviderSessionSchema,
  bars: Schema.Array(SipBarSchema),
  priorSessions: Schema.Array(
    Schema.Struct({
      session: MarketCalendarProviderSessionSchema,
      bars: Schema.Array(SipBarSchema),
    }),
  ).check(Schema.isMaxLength(15)),
  statuses: Schema.Array(
    Schema.Struct({
      symbol: SipSymbolSchema,
      effectiveAt: UtcInstantSchema,
      availableAt: UtcInstantSchema,
      active: Schema.Boolean,
    }),
  ),
  cutoffAt: UtcInstantSchema,
  observedAt: UtcInstantSchema,
  // An immutable timestamp from the opening checkpoint, even when evaluating later breakouts.
  openingObservedAt: Schema.NullOr(UtcInstantSchema),
})

export type AlphaV3Market = typeof AlphaV3MarketSchema.Type
export type SipSymbol = typeof SipSymbolSchema.Type
export type SipBar = typeof SipBarSchema.Type
export const decodeAlphaV3Market = Schema.decodeUnknownResult(AlphaV3MarketSchema, strictParseOptions)

export class AlphaV3EvidenceError extends Data.TaggedError('AlphaV3EvidenceError')<{
  readonly message: string
}> {}

export const sessionSchedule = (policy: IntradayAlphaV3Policy, session: EquityProviderSession) => {
  const open = Date.parse(session.regularOpenAt)
  const close = Date.parse(session.regularCloseAt)
  const orbExit = Math.min(
    open + policy.orb.exitMinuteFromOpen * minuteMs,
    close - policy.orb.closeBufferMinutes * minuteMs,
  )
  return {
    open,
    orbEntryEnd: Math.min(open + policy.orb.entryEndMinuteFromOpen * minuteMs, orbExit),
    noonEntry: open + policy.reversion.entryMinuteFromOpen * minuteMs,
    noiseEntryEnd: Math.min(
      open + policy.noise.entryEndMinuteFromOpen * minuteMs,
      close - policy.noise.entryCloseBufferMinutes * minuteMs,
    ),
    maximumHold: {
      [AlphaV3Engine.Orb]: orbExit,
      [AlphaV3Engine.Reversion]: close - policy.reversion.closeBufferMinutes * minuteMs,
      [AlphaV3Engine.Noise]: close - policy.noise.closeBufferMinutes * minuteMs,
    },
  }
}

export interface RegularBounds {
  readonly open: number
  readonly close: number
  readonly slots: number
}

const timeZone = 'America/New_York'

export const regularBounds = (session: EquityProviderSession): RegularBounds | null => {
  const open = Date.parse(session.regularOpenAt)
  const close = Date.parse(session.regularCloseAt)
  if (
    !Number.isFinite(open) ||
    !Number.isFinite(close) ||
    open % barMs !== 0 ||
    close % barMs !== 0 ||
    close <= open ||
    session.sessionOpenAt > session.regularOpenAt ||
    session.sessionCloseAt < session.regularCloseAt
  )
    return null

  // These strategy checkpoints are defined for the official 09:30 ET open.
  const localOpen = DateTime.makeZonedUnsafe(open, { timeZone })
  const localClose = DateTime.makeZonedUnsafe(close, { timeZone })
  const opens = DateTime.toParts(localOpen)
  const closes = DateTime.toParts(localClose)
  if (
    DateTime.formatIsoDate(localOpen) !== session.date ||
    DateTime.formatIsoDate(localClose) !== session.date ||
    opens.hour !== 9 ||
    opens.minute !== 30 ||
    closes.hour * 60 + closes.minute > 16 * 60
  )
    return null
  return { open, close, slots: (close - open) / barMs }
}
