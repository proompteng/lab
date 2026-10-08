/**
 * RESEARCH hybrid producer: crash ∩ VWAP + bounce confirm.
 *
 * Schema: bayn.hybrid-crash-vwap.shadow.v1
 * Status: RESEARCH_ONLY — never changes live fills.
 *
 * Mode is decoded once at the command boundary (`BAYN_HYBRID_CRASH_VWAP`, see
 * `hybrid-crash-vwap-shadow-command.ts`); this module is pure and receives decoded bars and the evaluation instant.
 *
 * Frozen params match docs/bayn/research-candidate-crash-vwap-bounce-v1.md
 * Evidence: docs/bayn/evidence/2026-10-07-hybrid-hf-v5/
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

/** Frozen research definition — do not retune without a new candidate id. */
export const hybridCrashVwapParams = {
  crashBp: 80,
  vwapDistBp: 60,
  ageMinMinutes: 30,
  bounceBars: 1,
  holdMinutes: 90,
  stopBp: 50,
  rthOpenMinutes: 9 * 60 + 30, // 09:30 ET as minute-of-day
  flattenMinutes: 15 * 60 + 55, // 15:55 ET
} as const

/** Closed `BAYN_HYBRID_CRASH_VWAP` vocabulary. There is no live mode until a separate promotion RFC. */
export enum HybridCrashVwapMode {
  Off = 'off',
  Shadow = 'shadow',
}

export const HybridCrashVwapModeSchema = Schema.Enum(HybridCrashVwapMode)

const MinuteOfDaySchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 24 * 60 - 1 }))

export const HybridBarSchema = Schema.Struct({
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

export const HybridCrashVwapSessionBarsSchema = Schema.Struct({
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
  readonly mode: HybridCrashVwapMode.Shadow
  readonly sessionDate: string
  readonly evaluatedAt: string
  readonly params: typeof hybridCrashVwapParams
  readonly candidates: readonly HybridCrashVwapCandidate[]
  readonly note: 'RESEARCH_ONLY_no_live_fills'
}

/**
 * Decode one session of bars from its JSON text. Every bar must belong to its symbol key and minutes must be strictly
 * ascending, so the pure scan below can rely on ordering and uniqueness.
 */
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

/** Session VWAP from typical price × volume (honest cumulative). */
export const sessionVwapSeries = (bars: readonly HybridBar[]): number[] => {
  const out: number[] = []
  let pv = 0
  let vv = 0
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3
    pv += tp * b.volume
    vv += b.volume
    out.push(vv > 0 ? pv / vv : b.close)
  }
  return out
}

/**
 * Scan one symbol's RTH bars (decoded: strictly ascending by minuteOfDay).
 * The crash return and bounce confirmation require exact minute continuity; a gap in sparse IEX data excludes the
 * opportunity instead of stretching the frozen one-minute signal. Bounce confirm waits +bounceBars minutes and
 * requires close rebound — no same-bar lookahead entry.
 */
export const collectCrashVwapBounceCandidates = (
  bars: readonly HybridBar[],
  params: typeof hybridCrashVwapParams = hybridCrashVwapParams,
): HybridCrashVwapCandidate[] => {
  if (bars.length < 3) return []
  const vwap = sessionVwapSeries(bars)
  const out: HybridCrashVwapCandidate[] = []
  for (let i = 1; i < bars.length; i++) {
    const signal = bars[i]
    const previous = bars[i - 1]
    const signalVwap = vwap[i]
    if (signal === undefined || previous === undefined || signalVwap === undefined) continue
    if (previous.minuteOfDay !== signal.minuteOfDay - 1) continue
    const age = signal.minuteOfDay - params.rthOpenMinutes
    if (age < params.ageMinMinutes) continue
    if (signal.minuteOfDay >= params.flattenMinutes - 5) continue
    if (previous.close <= 0 || signalVwap <= 0) continue
    const crashBp = (signal.close / previous.close - 1) * 1e4
    const distBp = (signal.close / signalVwap - 1) * 1e4
    if (crashBp > -params.crashBp || distBp > -params.vwapDistBp) continue
    const bounce = bars[i + params.bounceBars]
    if (bounce === undefined || bounce.minuteOfDay !== signal.minuteOfDay + params.bounceBars) continue
    if (bounce.close <= signal.close) continue
    if (bounce.minuteOfDay >= params.flattenMinutes - 2) continue
    out.push({
      symbol: signal.symbol,
      signalMinuteOfDay: signal.minuteOfDay,
      entryMinuteOfDay: bounce.minuteOfDay,
      crashBp,
      vwapDistBp: distBp,
      sessionVwap: signalVwap,
      signalClose: signal.close,
      entryClose: bounce.close,
    })
  }
  return out
}

/** Pure and deterministic: the caller supplies the evaluation instant from its `Clock` boundary. */
export const evaluateHybridCrashVwapShadow = (input: {
  readonly session: HybridCrashVwapSessionBars
  readonly evaluatedAt: string
}): HybridCrashVwapShadowRecord => {
  const candidates: HybridCrashVwapCandidate[] = []
  for (const symbol of Object.keys(input.session.barsBySymbol).toSorted()) {
    const bars = input.session.barsBySymbol[symbol]
    if (bars === undefined || bars.length === 0) continue
    candidates.push(...collectCrashVwapBounceCandidates(bars))
  }
  candidates.sort(
    (a, b) => a.entryMinuteOfDay - b.entryMinuteOfDay || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
  )
  return {
    schemaVersion: hybridCrashVwapSchemaVersion,
    model: hybridCrashVwapModel,
    mode: HybridCrashVwapMode.Shadow,
    sessionDate: input.session.sessionDate,
    evaluatedAt: input.evaluatedAt,
    params: hybridCrashVwapParams,
    candidates,
    note: 'RESEARCH_ONLY_no_live_fills',
  }
}
