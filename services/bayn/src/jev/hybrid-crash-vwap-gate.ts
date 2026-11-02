/**
 * RESEARCH hybrid producer: crash ∩ VWAP + bounce confirm.
 *
 * Schema: bayn.hybrid-crash-vwap.shadow.v2
 * Status: RESEARCH_ONLY — never changes live fills.
 *
 * Mode is decoded once at the command boundary (`BAYN_HYBRID_CRASH_VWAP`, see
 * `hybrid-crash-vwap-shadow-command.ts`); this module is pure and receives decoded bars and the evaluation instant.
 *
 * Frozen params match docs/bayn/research-candidate-crash-vwap-bounce-v1.md
 * Evidence: docs/bayn/evidence/2026-10-07-hybrid-hf-v5/
 */
import { BigDecimal, Data, Result, Schema } from 'effect'

import {
  IsoDateSchema,
  NonNegativeFiniteSchema,
  PositiveFiniteSchema,
  strictParseOptions,
  SymbolSchema,
  UtcSourceTimestampSchema,
} from '../schemas'

export const hybridCrashVwapSchemaVersion = 'bayn.hybrid-crash-vwap.shadow.v2' as const
export const hybridCrashVwapSessionBarsSchemaVersion = 'bayn.hybrid-crash-vwap.session-bars.v2' as const
export const hybridCrashVwapModel = 'crash-vwap-bounce-2.0.0' as const

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
  signalCutoffBeforeFlattenMinutes: 5,
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
  /** Start of the one-minute bar, matching the declared New York session. */
  timestamp: UtcSourceTimestampSchema,
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
  readonly confirmationMinuteOfDay: number
  readonly confirmationClose: number
  readonly entryOpen: number
  readonly entryBasis: 'NEXT_BAR_OPEN_RESEARCH_PROXY_NOT_EXECUTABLE_QUOTE'
}

export type HybridCrashVwapShadowRecord = {
  readonly schemaVersion: typeof hybridCrashVwapSchemaVersion
  readonly model: typeof hybridCrashVwapModel
  readonly mode: HybridCrashVwapMode.Shadow
  readonly sessionDate: string
  readonly evaluatedAt: string
  readonly params: typeof hybridCrashVwapParams
  readonly candidates: readonly HybridCrashVwapCandidate[]
  readonly source: HybridCrashVwapSessionBars['source']
  readonly qualification: 'UNQUALIFIED_SOURCE_DECLARATION_NOT_INDEPENDENTLY_VERIFIED'
  readonly acceptanceEligible: false
  readonly historicalEvidence: 'UNVERIFIED_GENERATOR_AND_CORPUS_UNAVAILABLE_NO_RERUN'
  readonly exclusions: readonly { readonly symbol: string; readonly reason: 'INCOMPLETE_RTH_MINUTE_COVERAGE' }[]
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
    const clock = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    if (
      new Set(session.source.universe).size !== session.source.universe.length ||
      session.source.completedThroughMinuteOfDay < hybridCrashVwapParams.rthOpenMinutes ||
      session.source.completedThroughMinuteOfDay >= session.source.sessionCloseMinuteOfDay
    )
      return yield* Result.fail(
        new HybridCrashVwapFailure({
          message: 'Hybrid crash-VWAP declared universe or completion watermark is invalid',
        }),
      )
    for (const [symbol, bars] of Object.entries(session.barsBySymbol)) {
      if (!session.source.universe.includes(symbol))
        return yield* Result.fail(
          new HybridCrashVwapFailure({
            message: `Hybrid crash-VWAP symbol ${symbol} is outside the declared universe`,
          }),
        )
      let previousMinute = -1
      for (const bar of bars) {
        const parts = Object.fromEntries(
          clock.formatToParts(new Date(bar.timestamp)).map((part) => [part.type, part.value]),
        )
        if (
          `${parts['year']}-${parts['month']}-${parts['day']}` !== session.sessionDate ||
          Number(parts['hour']) * 60 + Number(parts['minute']) !== bar.minuteOfDay ||
          Date.parse(bar.timestamp) % 60_000 !== 0 ||
          !/:00(?:\.0+)?Z$/.test(bar.timestamp) ||
          bar.minuteOfDay < hybridCrashVwapParams.rthOpenMinutes ||
          bar.minuteOfDay >= session.source.sessionCloseMinuteOfDay ||
          bar.minuteOfDay > session.source.completedThroughMinuteOfDay
        )
          return yield* Result.fail(
            new HybridCrashVwapFailure({
              message: `Hybrid crash-VWAP bar ${symbol} has inconsistent RTH session identity`,
            }),
          )
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
    if (b.minuteOfDay < hybridCrashVwapParams.rthOpenMinutes) {
      out.push(Number.NaN)
      continue
    }
    const tp = (b.high + b.low + b.close) / 3
    pv += tp * b.volume
    vv += b.volume
    out.push(vv > 0 ? pv / vv : Number.NaN)
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
  sessionCloseMinuteOfDay = 960,
): HybridCrashVwapCandidate[] => {
  if (bars.length < 4 || bars[0]?.minuteOfDay !== params.rthOpenMinutes) return []
  const flatten = Math.min(params.flattenMinutes, sessionCloseMinuteOfDay - 5)
  const vwap = sessionVwapSeries(bars)
  const out: HybridCrashVwapCandidate[] = []
  const basisPoints = BigDecimal.fromBigInt(10_000n)
  const tripleBasisPoints = BigDecimal.fromBigInt(30_000n)
  const crashPriceFactor = BigDecimal.fromNumberUnsafe(10_000 - params.crashBp)
  const vwapPriceFactor = BigDecimal.fromNumberUnsafe(10_000 - params.vwapDistBp)
  let cumulativeVolume = BigDecimal.fromBigInt(0n)
  let cumulativeTriplePriceVolume = BigDecimal.fromBigInt(0n)
  for (let i = 0; i < bars.length; i++) {
    const signal = bars[i]
    if (signal === undefined) continue
    // A late or gapped prefix cannot supply cumulative session VWAP. Never invent sparse IEX bars.
    if (signal.minuteOfDay !== params.rthOpenMinutes + i) break
    // Decoded finite decimal prices and volumes remain exact through both threshold comparisons.
    // Keep the typical-price factor of three in the denominator instead of rounding each bar's VWAP.
    const volume = BigDecimal.fromNumberUnsafe(signal.volume)
    const triplePrice = BigDecimal.sumAll([signal.high, signal.low, signal.close].map(BigDecimal.fromNumberUnsafe))
    cumulativeVolume = BigDecimal.sum(cumulativeVolume, volume)
    cumulativeTriplePriceVolume = BigDecimal.sum(cumulativeTriplePriceVolume, BigDecimal.multiply(triplePrice, volume))
    const previous = bars[i - 1]
    const signalVwap = vwap[i]
    if (previous === undefined || signalVwap === undefined) continue
    if (previous.minuteOfDay !== signal.minuteOfDay - 1) continue
    const age = signal.minuteOfDay - params.rthOpenMinutes
    if (age < params.ageMinMinutes) continue
    if (signal.minuteOfDay >= flatten - params.signalCutoffBeforeFlattenMinutes) continue
    if (previous.close <= 0 || !Number.isFinite(signalVwap) || signalVwap <= 0) continue
    // Numeric report fields are approximate; only the exact cross-products below decide admission.
    const crashBp = (signal.close / previous.close - 1) * 1e4
    const distBp = (signal.close / signalVwap - 1) * 1e4
    const close = BigDecimal.fromNumberUnsafe(signal.close)
    if (
      BigDecimal.isGreaterThan(
        BigDecimal.multiply(close, basisPoints),
        BigDecimal.multiply(BigDecimal.fromNumberUnsafe(previous.close), crashPriceFactor),
      ) ||
      BigDecimal.isGreaterThan(
        BigDecimal.multiply(BigDecimal.multiply(close, cumulativeVolume), tripleBasisPoints),
        BigDecimal.multiply(cumulativeTriplePriceVolume, vwapPriceFactor),
      )
    )
      continue
    const bounce = bars[i + params.bounceBars]
    if (bounce === undefined || bounce.minuteOfDay !== signal.minuteOfDay + params.bounceBars) continue
    if (bounce.close <= signal.close) continue
    const entry = bars[i + params.bounceBars + 1]
    if (entry === undefined || entry.minuteOfDay !== bounce.minuteOfDay + 1 || entry.minuteOfDay >= flatten) continue
    if ([previous, signal, bounce, entry].some((bar) => bar.volume <= 0)) continue
    out.push({
      symbol: signal.symbol,
      signalMinuteOfDay: signal.minuteOfDay,
      entryMinuteOfDay: entry.minuteOfDay,
      crashBp,
      vwapDistBp: distBp,
      sessionVwap: signalVwap,
      signalClose: signal.close,
      confirmationMinuteOfDay: bounce.minuteOfDay,
      confirmationClose: bounce.close,
      entryOpen: entry.open,
      entryBasis: 'NEXT_BAR_OPEN_RESEARCH_PROXY_NOT_EXECUTABLE_QUOTE',
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
  const exclusions: { symbol: string; reason: 'INCOMPLETE_RTH_MINUTE_COVERAGE' }[] = []
  for (const symbol of input.session.source.universe.toSorted()) {
    const bars = input.session.barsBySymbol[symbol]
    if (bars === undefined) {
      exclusions.push({ symbol, reason: 'INCOMPLETE_RTH_MINUTE_COVERAGE' })
      continue
    }
    if (
      bars.length !== input.session.source.completedThroughMinuteOfDay - hybridCrashVwapParams.rthOpenMinutes + 1 ||
      bars.some((bar, i) => bar.minuteOfDay !== hybridCrashVwapParams.rthOpenMinutes + i)
    )
      exclusions.push({ symbol, reason: 'INCOMPLETE_RTH_MINUTE_COVERAGE' })
    candidates.push(
      ...collectCrashVwapBounceCandidates(bars, hybridCrashVwapParams, input.session.source.sessionCloseMinuteOfDay),
    )
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
    source: input.session.source,
    qualification: 'UNQUALIFIED_SOURCE_DECLARATION_NOT_INDEPENDENTLY_VERIFIED',
    acceptanceEligible: false,
    historicalEvidence: 'UNVERIFIED_GENERATOR_AND_CORPUS_UNAVAILABLE_NO_RERUN',
    exclusions,
    note: 'RESEARCH_ONLY_no_live_fills',
  }
}
