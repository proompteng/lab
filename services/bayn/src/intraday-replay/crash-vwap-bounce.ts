/**
 * RESEARCH_ONLY crash-below-VWAP bounce scan. Pure: callers decode the session bars and supply `evaluatedAt`.
 * Definition: docs/bayn/research-candidate-crash-vwap-bounce-v1.md. Never feeds live fills.
 */
import { Data, Result, Schema } from 'effect'

import {
  IsoDateSchema,
  NonNegativeFiniteSchema,
  PositiveFiniteSchema,
  strictParseOptions,
  SymbolSchema,
} from '../schemas'

export const hybridCrashVwapSchemaVersion = 'bayn.hybrid-crash-vwap.shadow.v1' as const
export const hybridCrashVwapSessionBarsSchemaVersion = 'bayn.hybrid-crash-vwap.session-bars.v1' as const
export const hybridCrashVwapModel = 'crash-vwap-bounce-1.0.0' as const

/** Frozen signal definition; retuning requires a new model id. Minutes are America/New_York minute-of-day. */
export const hybridCrashVwapParams = {
  crashBp: 80,
  vwapDistBp: 60,
  minSessionAgeMinutes: 30,
  bounceMinutes: 1,
  rthOpenMinute: 9 * 60 + 30,
  lastSignalMinute: 15 * 60 + 50,
  lastEntryMinute: 15 * 60 + 53,
} as const

/** Closed `BAYN_HYBRID_CRASH_VWAP` vocabulary. There is no live mode until a separate promotion RFC. */
export enum HybridCrashVwapMode {
  Off = 'off',
  Shadow = 'shadow',
}

export const HybridCrashVwapModeSchema = Schema.Enum(HybridCrashVwapMode)

const MinuteOfDaySchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 24 * 60 - 1 }))

const HybridBarSchema = Schema.Struct({
  symbol: SymbolSchema,
  /** Minutes from midnight in America/New_York (RTH clock). */
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
  barsBySymbol: Schema.Record(SymbolSchema, Schema.Array(HybridBarSchema)),
})

export type HybridCrashVwapSessionBars = typeof HybridCrashVwapSessionBarsSchema.Type

export class HybridCrashVwapFailure extends Data.TaggedError('HybridCrashVwapFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type HybridCrashVwapCandidate = {
  readonly symbol: string
  readonly signalMinuteOfDay: number
  readonly entryMinuteOfDay: number
  readonly crashBp: number
  readonly vwapDistBp: number
  readonly sessionVwap: number
  readonly signalClose: number
  readonly entryClose: number
}

export type HybridCrashVwapShadowRecord = {
  readonly schemaVersion: typeof hybridCrashVwapSchemaVersion
  readonly model: typeof hybridCrashVwapModel
  readonly sessionDate: string
  readonly evaluatedAt: string
  readonly params: typeof hybridCrashVwapParams
  readonly candidates: readonly HybridCrashVwapCandidate[]
}

/** Bars must be filed under their own symbol, strictly ascending by minute, with open and close inside the range. */
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
    for (const [symbol, bars] of Object.entries(session.barsBySymbol)) {
      let previousMinute = -1
      for (const bar of bars) {
        if (bar.symbol !== symbol)
          return yield* Result.fail(
            new HybridCrashVwapFailure({ message: `Hybrid crash-VWAP bar ${bar.symbol} is filed under ${symbol}` }),
          )
        if (bar.minuteOfDay <= previousMinute)
          return yield* Result.fail(
            new HybridCrashVwapFailure({
              message: `Hybrid crash-VWAP bars for ${symbol} must be strictly ascending by minute`,
            }),
          )
        if (
          bar.low > bar.high ||
          bar.close < bar.low ||
          bar.close > bar.high ||
          bar.open < bar.low ||
          bar.open > bar.high
        )
          return yield* Result.fail(
            new HybridCrashVwapFailure({
              message: `Hybrid crash-VWAP bar ${symbol}@${bar.minuteOfDay} has an inconsistent range`,
            }),
          )
        previousMinute = bar.minuteOfDay
      }
    }
    return session
  })

/** Cumulative session VWAP of typical price. */
export const sessionVwapSeries = (bars: readonly HybridBar[]): number[] => {
  let priceVolume = 0
  let volume = 0
  return bars.map((bar) => {
    priceVolume += ((bar.high + bar.low + bar.close) / 3) * bar.volume
    volume += bar.volume
    return volume > 0 ? priceVolume / volume : bar.close
  })
}

/**
 * Signal: a one-minute close-to-close drop of at least `crashBp` that closes `vwapDistBp` below session VWAP, followed
 * `bounceMinutes` later by a higher close. Both steps need exact minute continuity, so gaps in sparse bars drop the
 * opportunity. Entry is the bounce bar's close.
 */
export const collectCrashVwapBounceCandidates = (
  bars: readonly HybridBar[],
  params: typeof hybridCrashVwapParams = hybridCrashVwapParams,
): HybridCrashVwapCandidate[] => {
  const vwap = sessionVwapSeries(bars)
  const candidates: HybridCrashVwapCandidate[] = []
  for (let index = 1; index < bars.length; index++) {
    const signal = bars[index]
    const previous = bars[index - 1]
    const sessionVwap = vwap[index]
    const bounce = bars[index + params.bounceMinutes]
    if (signal === undefined || previous === undefined || sessionVwap === undefined || bounce === undefined) continue
    if (previous.minuteOfDay !== signal.minuteOfDay - 1) continue
    if (bounce.minuteOfDay !== signal.minuteOfDay + params.bounceMinutes) continue
    if (signal.minuteOfDay < params.rthOpenMinute + params.minSessionAgeMinutes) continue
    if (signal.minuteOfDay > params.lastSignalMinute || bounce.minuteOfDay > params.lastEntryMinute) continue
    const crashBp = (signal.close / previous.close - 1) * 1e4
    const vwapDistBp = (signal.close / sessionVwap - 1) * 1e4
    if (crashBp > -params.crashBp || vwapDistBp > -params.vwapDistBp || bounce.close <= signal.close) continue
    candidates.push({
      symbol: signal.symbol,
      signalMinuteOfDay: signal.minuteOfDay,
      entryMinuteOfDay: bounce.minuteOfDay,
      crashBp,
      vwapDistBp,
      sessionVwap,
      signalClose: signal.close,
      entryClose: bounce.close,
    })
  }
  return candidates
}

export const evaluateHybridCrashVwapShadow = (input: {
  readonly session: HybridCrashVwapSessionBars
  readonly evaluatedAt: string
}): HybridCrashVwapShadowRecord => {
  const candidates = Object.values(input.session.barsBySymbol).flatMap((bars) => collectCrashVwapBounceCandidates(bars))
  candidates.sort(
    (a, b) => a.entryMinuteOfDay - b.entryMinuteOfDay || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
  )
  return {
    schemaVersion: hybridCrashVwapSchemaVersion,
    model: hybridCrashVwapModel,
    sessionDate: input.session.sessionDate,
    evaluatedAt: input.evaluatedAt,
    params: hybridCrashVwapParams,
    candidates,
  }
}
