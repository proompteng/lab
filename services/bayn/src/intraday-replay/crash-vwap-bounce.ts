/**
 * RESEARCH_ONLY crash-below-VWAP bounce scan over one declared session of one-minute bars. Pure: callers decode the
 * input and supply `evaluatedAt`. Definition: docs/bayn/research-candidate-crash-vwap-bounce-v1.md.
 */
import { Data, Result, Schema } from 'effect'

import {
  IsoDateSchema,
  NonNegativeFiniteSchema,
  PositiveFiniteSchema,
  strictParseOptions,
  SymbolSchema,
  UtcSourceTimestampSchema,
} from '../schemas'

export const hybridCrashVwapSchemaVersion = 'bayn.hybrid-crash-vwap.shadow.v3' as const
export const hybridCrashVwapSessionBarsSchemaVersion = 'bayn.hybrid-crash-vwap.session-bars.v2' as const
export const hybridCrashVwapModel = 'crash-vwap-bounce-2.0.0' as const

/** Frozen signal definition; retuning requires a new model id. Minutes are America/New_York minute-of-day. */
export const hybridCrashVwapParams = {
  crashBp: 80,
  vwapDistBp: 60,
  minSessionAgeMinutes: 30,
  bounceMinutes: 1,
  rthOpenMinute: 9 * 60 + 30,
  flattenMinute: 15 * 60 + 55,
  flattenBeforeCloseMinutes: 5,
  signalCutoffBeforeFlattenMinutes: 5,
} as const

/** Closed `BAYN_HYBRID_CRASH_VWAP` vocabulary. There is no live mode. */
export enum HybridCrashVwapMode {
  Off = 'off',
  Shadow = 'shadow',
}

export const HybridCrashVwapModeSchema = Schema.Enum(HybridCrashVwapMode)

const MinuteOfDaySchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 24 * 60 - 1 }))

const HybridBarSchema = Schema.Struct({
  symbol: SymbolSchema,
  /** Start of the one-minute bar. */
  timestamp: UtcSourceTimestampSchema,
  minuteOfDay: MinuteOfDaySchema,
  open: PositiveFiniteSchema,
  high: PositiveFiniteSchema,
  low: PositiveFiniteSchema,
  close: PositiveFiniteSchema,
  volume: NonNegativeFiniteSchema,
})

export type HybridBar = typeof HybridBarSchema.Type

const HybridCrashVwapSessionBarsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(hybridCrashVwapSessionBarsSchemaVersion),
  sessionDate: IsoDateSchema,
  source: Schema.Struct({
    provider: Schema.Literal('alpaca'),
    feed: Schema.Literal('iex'),
    datasetId: Schema.String.check(Schema.isMinLength(1)),
    calendarSource: Schema.String.check(Schema.isMinLength(1)),
    sessionCloseMinuteOfDay: Schema.Literals([780, 960]),
    universe: Schema.Array(SymbolSchema).check(Schema.isMinLength(1)),
    completedThroughMinuteOfDay: MinuteOfDaySchema,
  }),
  barsBySymbol: Schema.Record(SymbolSchema, Schema.Array(HybridBarSchema)),
})

export type HybridCrashVwapSessionBars = typeof HybridCrashVwapSessionBarsSchema.Type
type SessionSource = HybridCrashVwapSessionBars['source']

export class HybridCrashVwapFailure extends Data.TaggedError('HybridCrashVwapFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type HybridCrashVwapCandidate = {
  readonly symbol: string
  readonly signalMinuteOfDay: number
  readonly confirmationMinuteOfDay: number
  readonly entryMinuteOfDay: number
  readonly crashBp: number
  readonly vwapDistBp: number
  readonly sessionVwap: number
  readonly signalClose: number
  readonly confirmationClose: number
  /** Next-bar open after confirmation; a research proxy, not an executable quote. */
  readonly entryOpen: number
}

export type HybridCrashVwapExclusion = {
  readonly symbol: string
  readonly reason: 'INCOMPLETE_RTH_MINUTE_COVERAGE'
}

export type HybridCrashVwapShadowRecord = {
  readonly schemaVersion: typeof hybridCrashVwapSchemaVersion
  readonly model: typeof hybridCrashVwapModel
  readonly sessionDate: string
  readonly evaluatedAt: string
  readonly params: typeof hybridCrashVwapParams
  readonly source: SessionSource
  readonly candidates: readonly HybridCrashVwapCandidate[]
  readonly exclusions: readonly HybridCrashVwapExclusion[]
}

const failure = (message: string) => Result.fail(new HybridCrashVwapFailure({ message }))

const newYorkClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** The UTC minute-start timestamp must name the bar's New York session date and minute. */
const hasNewYorkIdentity = (bar: HybridBar, sessionDate: string) => {
  if (Date.parse(bar.timestamp) % 60_000 !== 0 || !/:00(?:\.0+)?Z$/.test(bar.timestamp)) return false
  const parts = Object.fromEntries(
    newYorkClock.formatToParts(new Date(bar.timestamp)).map((part) => [part.type, part.value]),
  )
  return (
    `${parts['year']}-${parts['month']}-${parts['day']}` === sessionDate &&
    Number(parts['hour']) * 60 + Number(parts['minute']) === bar.minuteOfDay
  )
}

const validateSource = (source: SessionSource) =>
  new Set(source.universe).size === source.universe.length &&
  source.completedThroughMinuteOfDay >= hybridCrashVwapParams.rthOpenMinute &&
  source.completedThroughMinuteOfDay < source.sessionCloseMinuteOfDay
    ? Result.succeed(source)
    : failure('Hybrid crash-VWAP declared universe or completion watermark is invalid')

const validateBars = (symbol: string, bars: readonly HybridBar[], session: HybridCrashVwapSessionBars) => {
  const { source, sessionDate } = session
  if (!source.universe.includes(symbol))
    return failure(`Hybrid crash-VWAP symbol ${symbol} is outside the declared universe`)
  let previousMinute = -1
  for (const bar of bars) {
    if (bar.symbol !== symbol) return failure(`Hybrid crash-VWAP bar ${bar.symbol} is filed under ${symbol}`)
    if (
      !hasNewYorkIdentity(bar, sessionDate) ||
      bar.minuteOfDay < hybridCrashVwapParams.rthOpenMinute ||
      bar.minuteOfDay >= source.sessionCloseMinuteOfDay ||
      bar.minuteOfDay > source.completedThroughMinuteOfDay
    )
      return failure(`Hybrid crash-VWAP bar ${symbol} has inconsistent RTH session identity`)
    if (bar.minuteOfDay <= previousMinute)
      return failure(`Hybrid crash-VWAP bars for ${symbol} must be strictly ascending by minute`)
    if (bar.low > bar.high || bar.close < bar.low || bar.close > bar.high || bar.open < bar.low || bar.open > bar.high)
      return failure(`Hybrid crash-VWAP bar ${symbol}@${bar.minuteOfDay} has an inconsistent range`)
    previousMinute = bar.minuteOfDay
  }
  return Result.succeed(bars)
}

/** Decodes one declared session; bars must sit inside the declared universe, RTH bounds and completion watermark. */
export const decodeHybridCrashVwapSessionBars = (text: string) =>
  Result.gen(function* () {
    const session = yield* Schema.decodeUnknownResult(
      Schema.fromJsonString(HybridCrashVwapSessionBarsSchema),
      strictParseOptions,
    )(text).pipe(
      Result.mapError(
        (cause) => new HybridCrashVwapFailure({ message: 'Hybrid crash-VWAP session bars are malformed', cause }),
      ),
    )
    yield* validateSource(session.source)
    for (const [symbol, bars] of Object.entries(session.barsBySymbol)) yield* validateBars(symbol, bars, session)
    return session
  })

/** Cumulative RTH session VWAP of typical price; NaN until volume trades. */
export const sessionVwapSeries = (bars: readonly HybridBar[]): number[] => {
  let priceVolume = 0
  let volume = 0
  return bars.map((bar) => {
    if (bar.minuteOfDay < hybridCrashVwapParams.rthOpenMinute) return Number.NaN
    priceVolume += ((bar.high + bar.low + bar.close) / 3) * bar.volume
    volume += bar.volume
    return volume > 0 ? priceVolume / volume : Number.NaN
  })
}

/**
 * A one-minute close-to-close drop of at least `crashBp` closing `vwapDistBp` below session VWAP, confirmed
 * `bounceMinutes` later by a higher close, enters at the following bar's open. History must be contiguous from the
 * open: a late or gapped prefix cannot supply session VWAP, so the scan stops there instead of inventing bars.
 */
export const collectCrashVwapBounceCandidates = (
  bars: readonly HybridBar[],
  params: typeof hybridCrashVwapParams = hybridCrashVwapParams,
  sessionCloseMinuteOfDay = 16 * 60,
): HybridCrashVwapCandidate[] => {
  const flattenMinute = Math.min(params.flattenMinute, sessionCloseMinuteOfDay - params.flattenBeforeCloseMinutes)
  const lastSignalMinute = flattenMinute - params.signalCutoffBeforeFlattenMinutes
  const vwap = sessionVwapSeries(bars)
  const candidates: HybridCrashVwapCandidate[] = []
  for (let index = 1; index < bars.length; index++) {
    const previous = bars[index - 1]
    const signal = bars[index]
    const confirmation = bars[index + params.bounceMinutes]
    const entry = bars[index + params.bounceMinutes + 1]
    const sessionVwap = vwap[index]
    if (previous?.minuteOfDay !== params.rthOpenMinute + index - 1) break
    if (signal?.minuteOfDay !== params.rthOpenMinute + index) break
    if (confirmation === undefined || entry === undefined || sessionVwap === undefined) break
    if (confirmation.minuteOfDay !== signal.minuteOfDay + params.bounceMinutes) continue
    if (entry.minuteOfDay !== confirmation.minuteOfDay + 1 || entry.minuteOfDay >= flattenMinute) continue
    if (signal.minuteOfDay < params.rthOpenMinute + params.minSessionAgeMinutes) continue
    if (signal.minuteOfDay >= lastSignalMinute || !Number.isFinite(sessionVwap)) continue
    if ([previous, signal, confirmation, entry].some((bar) => bar.volume <= 0)) continue
    const crashBp = (signal.close / previous.close - 1) * 1e4
    const vwapDistBp = (signal.close / sessionVwap - 1) * 1e4
    if (crashBp > -params.crashBp || vwapDistBp > -params.vwapDistBp || confirmation.close <= signal.close) continue
    candidates.push({
      symbol: signal.symbol,
      signalMinuteOfDay: signal.minuteOfDay,
      confirmationMinuteOfDay: confirmation.minuteOfDay,
      entryMinuteOfDay: entry.minuteOfDay,
      crashBp,
      vwapDistBp,
      sessionVwap,
      signalClose: signal.close,
      confirmationClose: confirmation.close,
      entryOpen: entry.open,
    })
  }
  return candidates
}

const hasCompleteCoverage = (bars: readonly HybridBar[], source: SessionSource) =>
  bars.length === source.completedThroughMinuteOfDay - hybridCrashVwapParams.rthOpenMinute + 1 &&
  bars.every((bar, index) => bar.minuteOfDay === hybridCrashVwapParams.rthOpenMinute + index)

export const evaluateHybridCrashVwapShadow = (input: {
  readonly session: HybridCrashVwapSessionBars
  readonly evaluatedAt: string
}): HybridCrashVwapShadowRecord => {
  const { source } = input.session
  const candidates: HybridCrashVwapCandidate[] = []
  const exclusions: HybridCrashVwapExclusion[] = []
  for (const symbol of source.universe.toSorted()) {
    const bars = input.session.barsBySymbol[symbol] ?? []
    if (!hasCompleteCoverage(bars, source)) exclusions.push({ symbol, reason: 'INCOMPLETE_RTH_MINUTE_COVERAGE' })
    candidates.push(...collectCrashVwapBounceCandidates(bars, hybridCrashVwapParams, source.sessionCloseMinuteOfDay))
  }
  candidates.sort(
    (a, b) => a.entryMinuteOfDay - b.entryMinuteOfDay || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
  )
  return {
    schemaVersion: hybridCrashVwapSchemaVersion,
    model: hybridCrashVwapModel,
    sessionDate: input.session.sessionDate,
    evaluatedAt: input.evaluatedAt,
    params: hybridCrashVwapParams,
    source,
    candidates,
    exclusions,
  }
}
