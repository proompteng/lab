import { Data, DateTime, Result, Schema } from 'effect'

import type { EquityProviderSession } from '../../equity-hours'
import { UtcInstantSchema } from '../../schemas'
import type { EtfNoiseAreaPolicy, EtfNoiseAreaSymbol } from './policy'

const minuteMs = 60_000
const standardSessionMinutes = 390
const timeZone = 'America/New_York'
const isUtc = Schema.is(UtcInstantSchema)
const abs = (value: bigint) => (value < 0n ? -value : value)
const wallMinute = (date: DateTime.Zoned) => {
  const { hour, minute } = DateTime.toParts(date)
  return hour * 60 + minute
}

export class NoiseAreaInputError extends Data.TaggedError('NoiseAreaInputError')<{
  readonly message: string
}> {}

type RegularSession = Pick<EquityProviderSession, 'date' | 'regularOpenAt' | 'regularCloseAt'>

const regularBounds = (session: RegularSession) => {
  const open = Date.parse(session.regularOpenAt)
  const close = Date.parse(session.regularCloseAt)
  if (
    !isUtc(session.regularOpenAt) ||
    !isUtc(session.regularCloseAt) ||
    open % minuteMs !== 0 ||
    close % minuteMs !== 0 ||
    close <= open ||
    close - open > standardSessionMinutes * minuteMs
  )
    return null
  const openEt = DateTime.makeZonedUnsafe(open, { timeZone })
  const closeEt = DateTime.makeZonedUnsafe(close, { timeZone })
  if (DateTime.formatIsoDate(openEt) !== session.date || DateTime.formatIsoDate(closeEt) !== session.date) return null
  return { open, close, standardOpen: wallMinute(openEt) === 9 * 60 + 30, earlyClose: wallMinute(closeEt) < 16 * 60 }
}

export const noiseAreaSessionSchedule = (policy: EtfNoiseAreaPolicy, session: RegularSession) => {
  const bounds = regularBounds(session)
  if (bounds === null || bounds.close - bounds.open <= policy.flattenMinutesBeforeRegularClose * minuteMs) {
    return Result.fail(new NoiseAreaInputError({ message: `Invalid provider regular session for ${session.date}` }))
  }
  const lastCheckpoint = Math.min(
    bounds.open + policy.lastCheckpointMinuteFromOpen * minuteMs,
    bounds.close - policy.minimumEntryMinutesBeforeClose * minuteMs,
  )
  const checkpointTimes: string[] = []
  const step = policy.checkpointMinutes * minuteMs
  // An exceptional opening time must not shift the strategy into a different time-of-day regime.
  if (bounds.standardOpen) {
    for (let at = bounds.open + step; at <= lastCheckpoint; at += step) {
      checkpointTimes.push(new Date(at).toISOString())
    }
  }
  return Result.succeed({
    checkpointTimes,
    flattenAt: new Date(bounds.close - policy.flattenMinutesBeforeRegularClose * minuteMs).toISOString(),
    earlyClose: bounds.earlyClose,
  })
}

export interface NoiseAreaBar {
  readonly symbol: EtfNoiseAreaSymbol
  /** Start of a finalized regular-session minute bar. */
  readonly eventAt: string
  /** Actual availability of this exact revision, not the event time or a backfill timestamp. */
  readonly availableAt: string
  readonly openPriceMicros: bigint
  readonly closePriceMicros: bigint
}

export interface PriorNoiseAreaSession {
  readonly symbol: EtfNoiseAreaSymbol
  readonly sessionDate: string
  /** Availability of the complete, same-feed RTH summary and its checkpoint closes. */
  readonly availableAt: string
  readonly openPriceMicros: bigint
  readonly highPriceMicros: bigint
  readonly lowPriceMicros: bigint
  readonly closePriceMicros: bigint
  /** Official prior regular close, including the anchor before the first ATR14 sample. */
  readonly previousClosePriceMicros: bigint
  /** Exact checkpoint closes keyed by elapsed minutes from the regular open, not bar start. */
  readonly checkpointCloseMicros: Readonly<Partial<Record<number, bigint>>>
}

export type NoiseAreaPositionSide = 'LONG' | 'SHORT'
type PositionState =
  | { readonly _tag: 'Flat'; readonly entryTaken: boolean }
  | { readonly _tag: 'Holding'; readonly side: NoiseAreaPositionSide }

export interface NoiseAreaVolatility {
  readonly sessionOpenPriceMicros: bigint
  readonly atr14Micros: bigint
}

export type NoiseAreaBreakout = NoiseAreaVolatility & {
  readonly _tag: 'LongBreakout' | 'ShortBreakout'
  readonly symbol: EtfNoiseAreaSymbol
  readonly checkpointAt: string
  readonly referencePriceMicros: bigint
  readonly flattenAt: string
}

export type NoiseAreaExitSignal = {
  readonly _tag: 'OppositeBandExit' | 'TimedFlatten' | 'TimedHalfDayFlatten'
  readonly symbol: EtfNoiseAreaSymbol
  readonly side: NoiseAreaPositionSide
  readonly flattenAt: string
}

export type NoiseAreaSignal =
  | NoiseAreaBreakout
  | NoiseAreaExitSignal
  | { readonly _tag: 'NoSignal'; readonly volatility?: NoiseAreaVolatility }
  | {
      readonly _tag: 'MissingWarmup'
      readonly reason: 'PriorSessions' | 'PriorCheckpoint' | 'Volatility' | 'CurrentBars'
    }

const noSignal = { _tag: 'NoSignal' } as const
const missing = (reason: Extract<NoiseAreaSignal, { _tag: 'MissingWarmup' }>['reason']): NoiseAreaSignal => ({
  _tag: 'MissingWarmup',
  reason,
})

export const evaluateNoiseAreaCheckpoint = (input: {
  readonly policy: EtfNoiseAreaPolicy
  readonly symbol: EtfNoiseAreaSymbol
  readonly sessionDate: string
  /** Authoritative provider sessions, including the target and the immediately preceding official sessions. */
  readonly providerSessions: readonly RegularSession[]
  readonly priorSessions: readonly PriorNoiseAreaSession[]
  readonly bars: readonly NoiseAreaBar[]
  readonly checkpointAt: string
  readonly observedAt: string
  readonly position: PositionState
}): Result.Result<NoiseAreaSignal, NoiseAreaInputError> =>
  Result.gen(function* () {
    const { policy, symbol, sessionDate, observedAt, checkpointAt, position } = input
    if (!policy.symbols.some((member) => member === symbol)) return noSignal

    const sessions = input.providerSessions
      .filter((session) => session.date <= sessionDate)
      .toSorted((a, b) => a.date.localeCompare(b.date))
    const session = sessions.at(-1)
    if (session?.date !== sessionDate || sessions.at(-2)?.date === sessionDate || !isUtc(observedAt)) {
      return yield* Result.fail(
        new NoiseAreaInputError({ message: `No unique provider session or valid clock for ${sessionDate}` }),
      )
    }
    const schedule = yield* noiseAreaSessionSchedule(policy, session)
    const { flattenAt } = schedule
    if (observedAt >= flattenAt) {
      if (position._tag === 'Flat') return noSignal
      return {
        _tag: schedule.earlyClose ? 'TimedHalfDayFlatten' : 'TimedFlatten',
        symbol,
        side: position.side,
        flattenAt,
      }
    }
    // A checkpoint may be evaluated on receipt of its closing minute, but not reused after the next minute completes.
    if (
      !schedule.checkpointTimes.includes(checkpointAt) ||
      observedAt < checkpointAt ||
      Date.parse(observedAt) >= Date.parse(checkpointAt) + minuteMs
    ) {
      return noSignal
    }
    const openMs = Date.parse(session.regularOpenAt)
    const checkpointMs = Date.parse(checkpointAt)
    const elapsedMinutes = (checkpointMs - openMs) / minuteMs
    const checkpointBarStart = new Date(checkpointMs - minuteMs).toISOString()
    const minuteEnds = new Map([
      [session.regularOpenAt, new Date(openMs + minuteMs).toISOString()],
      [checkpointBarStart, checkpointAt],
    ])
    const calendar = sessions.slice(0, -1).slice(-policy.lookbackSessions)
    const priorCloses = new Map(calendar.map((prior) => [prior.date, prior.regularCloseAt]))

    // Validate required evidence before selecting revisions or returning a missing-warmup result.
    const prematureBar = input.bars.find((bar) => {
      const end = minuteEnds.get(bar.eventAt)
      return bar.symbol === symbol && end !== undefined && isUtc(bar.availableAt) && bar.availableAt < end
    })
    if (prematureBar !== undefined) {
      return yield* Result.fail(
        new NoiseAreaInputError({
          message: `${symbol} bar at ${prematureBar.eventAt} was available at ${prematureBar.availableAt} before minute completion`,
        }),
      )
    }
    const prematurePrior = input.priorSessions.find((row) => {
      const close = priorCloses.get(row.sessionDate)
      return (
        row.symbol === symbol &&
        close !== undefined &&
        isUtc(close) &&
        isUtc(row.availableAt) &&
        row.availableAt < close
      )
    })
    if (prematurePrior !== undefined) {
      return yield* Result.fail(
        new NoiseAreaInputError({
          message: `${symbol} summary for ${prematurePrior.sessionDate} was available at ${prematurePrior.availableAt} before regular close`,
        }),
      )
    }

    const completedBar = (start: string) => {
      const matches = input.bars.filter(
        (bar) =>
          bar.symbol === symbol && bar.eventAt === start && isUtc(bar.availableAt) && bar.availableAt <= observedAt,
      )
      return matches.length === 1 ? matches[0] : undefined
    }
    const open = completedBar(session.regularOpenAt)?.openPriceMicros
    const close = completedBar(checkpointBarStart)?.closePriceMicros
    if (open === undefined || close === undefined || open <= 0n || close <= 0n) return missing('CurrentBars')

    if (calendar.length !== policy.lookbackSessions || priorCloses.size !== calendar.length) {
      return missing('PriorSessions')
    }

    // Retain exact absolute-return ratios so a close on the band is not rounded into a breakout.
    let swingNumerator = 0n
    let swingDenominator = 1n
    let trueRangeSum = 0n
    let prevClose: bigint | undefined
    for (const prior of calendar) {
      const bounds = regularBounds(prior)
      if (bounds === null || !bounds.standardOpen || bounds.close > openMs) return missing('PriorSessions')
      const matches = input.priorSessions.filter(
        (row) =>
          row.symbol === symbol &&
          row.sessionDate === prior.date &&
          isUtc(row.availableAt) &&
          row.availableAt <= observedAt,
      )
      const row = matches[0]
      if (matches.length !== 1 || row === undefined) return missing('PriorSessions')

      const { openPriceMicros, highPriceMicros, lowPriceMicros, closePriceMicros, previousClosePriceMicros } = row
      if (
        lowPriceMicros <= 0n ||
        openPriceMicros < lowPriceMicros ||
        openPriceMicros > highPriceMicros ||
        closePriceMicros < lowPriceMicros ||
        closePriceMicros > highPriceMicros ||
        previousClosePriceMicros <= 0n ||
        (prevClose !== undefined && previousClosePriceMicros !== prevClose)
      ) {
        return yield* Result.fail(
          new NoiseAreaInputError({
            message: `${symbol} prior summary for ${row.sessionDate} has malformed OHLC or inconsistent previous close`,
          }),
        )
      }

      const checkpointClose = row.checkpointCloseMicros[elapsedMinutes]
      if (bounds.open + elapsedMinutes * minuteMs > bounds.close || checkpointClose === undefined)
        return missing('PriorCheckpoint')
      if (checkpointClose < lowPriceMicros || checkpointClose > highPriceMicros) {
        return yield* Result.fail(
          new NoiseAreaInputError({
            message: `${symbol} prior checkpoint close for ${row.sessionDate} falls outside session low/high range`,
          }),
        )
      }

      swingNumerator = swingNumerator * openPriceMicros + abs(checkpointClose - openPriceMicros) * swingDenominator
      swingDenominator *= openPriceMicros

      const trueHigh = highPriceMicros > previousClosePriceMicros ? highPriceMicros : previousClosePriceMicros
      const trueLow = lowPriceMicros < previousClosePriceMicros ? lowPriceMicros : previousClosePriceMicros
      trueRangeSum += trueHigh - trueLow
      prevClose = closePriceMicros
    }
    if (prevClose === undefined) return missing('PriorSessions')
    const count = BigInt(policy.lookbackSessions)
    const volatility = {
      sessionOpenPriceMicros: open,
      atr14Micros: (trueRangeSum + count - 1n) / count,
    }
    const denominator = swingDenominator * count * 10n
    const band = swingNumerator * BigInt(policy.bandMultiplier * 10)
    const upperAnchor = open > prevClose ? open : prevClose
    const lowerAnchor = open < prevClose ? open : prevClose
    const above = close * denominator > upperAnchor * (denominator + band)
    const below = close * denominator < lowerAnchor * (denominator - band)
    if (position._tag === 'Holding') {
      return (position.side === 'LONG' ? below : above)
        ? { _tag: 'OppositeBandExit', symbol, side: position.side, flattenAt }
        : { ...noSignal, volatility }
    }
    if (band === 0n) return { ...noSignal, volatility }
    if (volatility.atr14Micros === 0n) return missing('Volatility')
    if (position.entryTaken || (!above && !below)) return { ...noSignal, volatility }
    return {
      _tag: above ? 'LongBreakout' : 'ShortBreakout',
      symbol,
      checkpointAt,
      referencePriceMicros: close,
      ...volatility,
      flattenAt,
    }
  })
