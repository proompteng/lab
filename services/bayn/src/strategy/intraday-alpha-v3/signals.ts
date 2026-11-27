import { Result } from 'effect'

import {
  AlphaV3EvidenceError,
  minuteMs,
  regularBounds,
  sessionSchedule,
  type AlphaV3Market,
  type RegularBounds,
  type SipBar,
  type SipSymbol,
} from './market'
import {
  AlphaV3Direction,
  AlphaV3Engine,
  benchmarkSymbol,
  equitySymbols,
  trendSymbols,
  type AlphaV3Symbol,
  type EquitySymbol,
  type IntradayAlphaV3Policy,
  type TrendSymbol,
} from './policy'

export interface AlphaV3Signal {
  readonly symbol: AlphaV3Symbol
  readonly direction: AlphaV3Direction
  readonly referenceMicros: bigint
  readonly atr14Micros: bigint
}

export interface AlphaV3OrbSignal extends AlphaV3Signal {
  readonly symbol: EquitySymbol
  readonly rangeStopMicros: bigint
}

export interface AlphaV3NoonSignal extends AlphaV3Signal {
  readonly symbol: EquitySymbol
}

export interface AlphaV3NoiseSignal extends AlphaV3Signal {
  readonly symbol: TrendSymbol
}

export interface AlphaV3Entries {
  readonly [AlphaV3Engine.Orb]: AlphaV3OrbSignal | null
  readonly [AlphaV3Engine.Reversion]: readonly AlphaV3NoonSignal[]
  readonly [AlphaV3Engine.Noise]: readonly AlphaV3NoiseSignal[]
}

export interface AlphaV3SignalState {
  /** Held or still fillable pending entries at this observation, across all sleeves. */
  readonly occupiedSymbols: ReadonlySet<string>
  /** Includes pending, filled, and attempted entries that consumed the session's single opportunity. */
  readonly noiseUsed: ReadonlySet<TrendSymbol>
  readonly noisePositions: ReadonlyMap<TrendSymbol, AlphaV3Direction>
  readonly orbUsed: boolean
  readonly noonUsed: boolean
}

const abs = (n: bigint) => (n < 0n ? -n : n)
const ratio = (n: bigint, d: bigint) => Number(n / d) + Number(n % d) / Number(d)
const sortSymbol = (a: SipSymbol, b: SipSymbol) => (a < b ? -1 : a > b ? 1 : 0)
const compare = (n: bigint) => (n < 0n ? -1 : n > 0n ? 1 : 0)
const orbDirection = (open: bigint, close: bigint) =>
  open === close ? null : close > open ? AlphaV3Direction.Long : AlphaV3Direction.Short

// Keep relative VWAP scores and quartiles exact at the inclusive 100 bp boundary.
interface Fraction {
  readonly n: bigint
  readonly d: bigint
}
const minus = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.d - b.n * a.d, d: a.d * b.d })
const compareFractions = (a: Fraction, b: Fraction) => compare(a.n * b.d - b.n * a.d)
const quartile = (rows: readonly { readonly deviation: Fraction }[], q: 1 | 3): Fraction | null => {
  const position = (rows.length - 1) * q
  const index = Math.floor(position / 4)
  const lower = rows[index]?.deviation
  const upper = rows[index + 1]?.deviation
  const remainder = BigInt(position % 4)
  if (lower === undefined) return null
  if (remainder === 0n || upper === undefined) return lower
  return {
    n: lower.n * upper.d * (4n - remainder) + upper.n * lower.d * remainder,
    d: 4n * lower.d * upper.d,
  }
}

interface Bar {
  readonly open: bigint
  readonly high: bigint
  readonly low: bigint
  readonly close: bigint
  readonly vwap: bigint
  readonly volume: bigint
  readonly available: number
}
type Slots = ReadonlyMap<number, Bar>
type SessionBars = ReadonlyMap<SipSymbol, Slots>

const indexBars = (
  bars: readonly SipBar[],
  session: RegularBounds,
  cutoff: number,
  observed: number,
  interval: number,
) =>
  Result.gen(function* () {
    const indexed = new Map<SipSymbol, Map<number, Bar>>()
    for (const row of bars) {
      const start = Date.parse(row.startAt)
      const available = Date.parse(row.availableAt)
      if (start < session.open || start >= session.close || start >= cutoff || available > observed) continue
      const slot = (start - session.open) / interval
      if (!Number.isInteger(slot) || available < start + interval) {
        return yield* Result.fail(
          new AlphaV3EvidenceError({ message: `Invalid SIP timing: ${row.symbol} ${row.startAt}` }),
        )
      }
      if (start + interval > cutoff) continue
      const bar = {
        open: BigInt(row.openMicros),
        high: BigInt(row.highMicros),
        low: BigInt(row.lowMicros),
        close: BigInt(row.closeMicros),
        vwap: BigInt(row.vwapMicros),
        volume: BigInt(row.volume),
        available,
      }
      const bySlot = indexed.get(row.symbol) ?? new Map<number, Bar>()
      if (
        bySlot.has(slot) ||
        bar.high < bar.open ||
        bar.high < bar.close ||
        bar.low > bar.open ||
        bar.low > bar.close ||
        bar.low > bar.vwap ||
        bar.high < bar.vwap
      ) {
        return yield* Result.fail(
          new AlphaV3EvidenceError({ message: `Duplicate or malformed SIP bar: ${row.symbol} ${row.startAt}` }),
        )
      }
      bySlot.set(slot, bar)
      indexed.set(row.symbol, bySlot)
    }
    return indexed
  })

const regularWayFrom: Readonly<Partial<Record<SipSymbol, string>>> = {
  ALAB: '2024-03-20',
  GEV: '2024-04-02',
  SNDK: '2025-02-24',
}

interface PriorDay {
  readonly date: string
  readonly bounds: RegularBounds
  readonly bars: SessionBars
}
interface PriorFeatures {
  readonly previousClose: bigint
  readonly volumeSum: bigint
  readonly atr14Micros: bigint
  readonly trueRangeSum: bigint
  readonly sessions: readonly Slots[]
}
const visible = (slots: Slots | undefined, index: number, observed: number) => {
  const bar = slots?.get(index)
  return bar !== undefined && bar.available <= observed ? bar : undefined
}
const priorFeatures = (
  history: readonly PriorDay[],
  symbol: SipSymbol,
  today: string,
  observed: number,
  count: number,
): PriorFeatures | null => {
  const required = history.slice(-count)
  if (required.length !== count) return null
  const floor = symbol === 'WDC' && today >= '2025-02-24' ? '2025-02-24' : regularWayFrom[symbol]
  if (floor !== undefined && required.some(({ date }) => date < floor)) return null
  const warmup = history.at(-(count + 1))
  const warmupSlots = warmup?.bars.get(symbol)
  let previousClose =
    warmup !== undefined &&
    (floor === undefined || warmup.date >= floor) &&
    warmupSlots?.size === warmup.bounds.slots &&
    [...warmupSlots.values()].every((bar) => bar.available <= observed)
      ? visible(warmupSlots, warmup.bounds.slots - 1, observed)?.close
      : undefined
  let trueRangeSum = 0n
  let volumeSum = 0n
  const sessions: Slots[] = []
  for (const session of required) {
    const slots = session.bars.get(symbol)
    const first = visible(slots, 0, observed)
    const last = visible(slots, session.bounds.slots - 1, observed)
    if (slots === undefined || first === undefined || last === undefined || slots.size !== session.bounds.slots)
      return null
    let { high, low } = first
    for (const bar of slots.values()) {
      if (bar.available > observed) return null
      if (bar.high > high) high = bar.high
      if (bar.low < low) low = bar.low
    }
    const anchor = previousClose ?? first.open
    trueRangeSum += (anchor > high ? anchor : high) - (anchor < low ? anchor : low)
    volumeSum += first.volume
    previousClose = last.close
    sessions.push(slots)
  }
  if (previousClose === undefined) return null
  const n = BigInt(count)
  return { previousClose, volumeSum, trueRangeSum, atr14Micros: (trueRangeSum + n - 1n) / n, sessions }
}

const statusAt = (statuses: AlphaV3Market['statuses'], asOf: number, observed: number, date: string) => {
  const latest = new Map<SipSymbol, AlphaV3Market['statuses'][number]>()
  for (const status of statuses) {
    if (Date.parse(status.effectiveAt) > asOf || Date.parse(status.availableAt) > observed) continue
    const prev = latest.get(status.symbol)
    if (
      prev === undefined ||
      status.effectiveAt > prev.effectiveAt ||
      (status.effectiveAt === prev.effectiveAt &&
        (status.availableAt > prev.availableAt || (status.availableAt === prev.availableAt && !status.active)))
    )
      latest.set(status.symbol, status)
  }
  return (symbol: SipSymbol) => {
    const listedFrom = regularWayFrom[symbol]
    return latest.get(symbol)?.active === true && (listedFrom === undefined || date >= listedFrom)
  }
}

interface Features {
  readonly policy: IntradayAlphaV3Policy
  readonly market: AlphaV3Market
  readonly state: AlphaV3SignalState
  readonly today: SessionBars
  readonly history: readonly PriorDay[]
  readonly schedule: ReturnType<typeof sessionSchedule>
  readonly cutoff: number
  readonly observed: number
  readonly slot: number
  readonly active: (symbol: SipSymbol) => boolean
}

interface OrbCandidateDiagnostic {
  readonly symbol: EquitySymbol
  readonly reason:
    | 'inactive-at-opening-checkpoint'
    | 'missing-or5'
    | 'missing-prior-history'
    | 'rvol-below-minimum'
    | 'gap-below-minimum'
    | 'flat-opening-bar'
    | 'rankable'
  readonly direction?: AlphaV3Direction | null
  readonly rvol?: number
  readonly gapBps?: number
  readonly gapInAtr?: number
  readonly gapAligned?: boolean | null
}

interface NoonCandidateDiagnostic {
  readonly symbol: EquitySymbol
  readonly reason: 'inactive' | 'occupied' | 'missing-prior-history' | 'incomplete-vwap-path' | 'rankable'
  readonly relativeVwapBps?: number
}

const orb = (f: Features) => {
  const { market, policy, state, schedule, cutoff, observed } = f
  const rangeEnd = schedule.open + policy.orb.openingRangeMinutes * minuteMs
  const openingObserved = market.openingObservedAt === null ? null : Date.parse(market.openingObservedAt)
  const candidates: OrbCandidateDiagnostic[] = []
  const skip = (reason: string) => ({ signal: null, reason, candidates, topSymbol: null })
  if (cutoff < rangeEnd || cutoff > schedule.orbEntryEnd || observed >= schedule.maximumHold[AlphaV3Engine.Orb])
    return skip('outside-window')
  if (state.orbUsed) return skip('already-used')
  if (openingObserved === null || openingObserved > observed) return skip('missing-opening-checkpoint')
  const activeAtOpen = statusAt(market.statuses, rangeEnd, openingObserved, market.session.date)
  const activeAtOpeningReceipt = statusAt(market.statuses, openingObserved, openingObserved, market.session.date)

  const ranked = []
  for (const symbol of equitySymbols) {
    if (!activeAtOpen(symbol) || !activeAtOpeningReceipt(symbol)) {
      candidates.push({ symbol, reason: 'inactive-at-opening-checkpoint' })
      continue
    }
    const first = visible(f.today.get(symbol), 0, openingObserved)
    const prior = priorFeatures(f.history, symbol, market.session.date, openingObserved, policy.priorSessions)
    if (first === undefined || prior === null || prior.trueRangeSum === 0n) {
      candidates.push({ symbol, reason: first === undefined ? 'missing-or5' : 'missing-prior-history' })
      continue
    }
    const direction = orbDirection(first.open, first.close)
    const gap = first.open - prior.previousClose
    const rvolNumerator = first.volume * BigInt(policy.priorSessions)
    const enoughVolume = 2n * rvolNumerator >= BigInt(policy.orb.minimumRvol * 2) * prior.volumeSum
    const enoughGap =
      2n * abs(gap) * BigInt(policy.priorSessions) >= BigInt(policy.orb.minimumGapAtr * 2) * prior.trueRangeSum
    const reason = !enoughVolume
      ? 'rvol-below-minimum'
      : !enoughGap
        ? 'gap-below-minimum'
        : direction === null
          ? 'flat-opening-bar'
          : 'rankable'
    candidates.push({
      symbol,
      reason,
      direction,
      rvol: ratio(rvolNumerator, prior.volumeSum),
      gapBps: ratio(10_000n * gap, prior.previousClose),
      gapInAtr: ratio(gap * BigInt(policy.priorSessions), prior.trueRangeSum),
      gapAligned: direction === null ? null : direction === AlphaV3Direction.Long ? gap > 0n : gap < 0n,
    })
    if (enoughVolume && enoughGap && direction !== null) ranked.push({ symbol, first, prior, direction, rvolNumerator })
  }
  ranked.sort(
    (a, b) =>
      compare(b.rvolNumerator * a.prior.volumeSum - a.rvolNumerator * b.prior.volumeSum) ||
      sortSymbol(a.symbol, b.symbol),
  )
  const winner = ranked[0]
  if (winner === undefined) return skip('no-ranked-candidate')
  const { symbol, direction, first, prior } = winner
  const result = (reason: string, signal: AlphaV3OrbSignal | null = null) => ({
    reason,
    signal,
    candidates,
    topSymbol: symbol,
  })
  if (!f.active(symbol)) return result('inactive-winner')
  if (state.occupiedSymbols.has(symbol)) return result('occupied-winner')
  const slots = f.today.get(symbol)
  const long = direction === AlphaV3Direction.Long
  const stop = long ? first.low : first.high
  for (let i = 1; i <= f.slot; i++) {
    const bar = visible(slots, i, observed)
    if (bar === undefined) return result('incomplete-breakout-path')
    if (long ? bar.high <= first.high : bar.low >= first.low) continue
    if (i < f.slot) return result('earlier-breakout')
    if (long ? bar.close <= stop : bar.close >= stop) return result('reference-through-stop')
    return result('signal', {
      symbol,
      direction,
      referenceMicros: bar.close,
      atr14Micros: prior.atr14Micros,
      rangeStopMicros: stop,
    })
  }
  return result('awaiting-breakout')
}

const relativeVwap = (slots: Slots | undefined, index: number, observed: number) => {
  const latest = visible(slots, index, observed)
  if (latest === undefined) return null
  let priceVolume = 0n
  let volume = 0n
  for (let i = 0; i <= index; i++) {
    const bar = visible(slots, i, observed)
    if (bar === undefined) return null
    priceVolume += bar.vwap * bar.volume
    volume += bar.volume
  }
  return { close: latest.close, deviation: { n: 10_000n * (latest.close * volume - priceVolume), d: priceVolume } }
}

const noon = (f: Features, orbSignal: AlphaV3OrbSignal | null) => {
  const { market, policy, state, schedule, cutoff, observed } = f
  const diagnostics: NoonCandidateDiagnostic[] = []
  const skip = (reason: string) => ({
    reason,
    q1Bps: null,
    q3Bps: null,
    iqrBps: null,
    iqrExact: null,
    diagnostics,
    signals: [],
  })
  if (cutoff !== schedule.noonEntry || observed >= schedule.maximumHold[AlphaV3Engine.Reversion])
    return skip('outside-window')
  if (state.noonUsed) return skip('already-used')
  const spy = relativeVwap(f.today.get(benchmarkSymbol), f.slot, observed)
  const spyPrior = priorFeatures(f.history, benchmarkSymbol, market.session.date, observed, policy.priorSessions)
  if (!f.active(benchmarkSymbol) || spy === null || spyPrior === null) return skip('unavailable-spy')
  const ranked = []
  for (const symbol of equitySymbols) {
    if (!f.active(symbol) || state.occupiedSymbols.has(symbol) || orbSignal?.symbol === symbol) {
      diagnostics.push({ symbol, reason: !f.active(symbol) ? 'inactive' : 'occupied' })
      continue
    }
    const prior = priorFeatures(f.history, symbol, market.session.date, observed, policy.priorSessions)
    const current = relativeVwap(f.today.get(symbol), f.slot, observed)
    if (prior === null || current === null) {
      diagnostics.push({ symbol, reason: prior === null ? 'missing-prior-history' : 'incomplete-vwap-path' })
      continue
    }
    const deviation = minus(current.deviation, spy.deviation)
    ranked.push({ symbol, deviation, referenceMicros: current.close, atr14Micros: prior.atr14Micros })
    diagnostics.push({ symbol, reason: 'rankable', relativeVwapBps: ratio(deviation.n, deviation.d) })
  }
  ranked.sort((a, b) => compareFractions(a.deviation, b.deviation) || sortSymbol(a.symbol, b.symbol))
  const q1 = quartile(ranked, 1)
  const q3 = quartile(ranked, 3)
  if (q1 === null || q3 === null) return skip('insufficient-candidates')
  const iqr = minus(q3, q1)
  const base = {
    q1Bps: ratio(q1.n, q1.d),
    q3Bps: ratio(q3.n, q3.d),
    iqrBps: ratio(iqr.n, iqr.d),
    iqrExact: { numerator: iqr.n.toString(), denominator: iqr.d.toString() },
    diagnostics,
  }
  const pairs = policy.reversion.pairs
  if (ranked.length < 2 * pairs) return { ...base, reason: 'insufficient-candidates', signals: [] }
  if (iqr.n < BigInt(policy.reversion.minimumIqrBps) * iqr.d)
    return { ...base, reason: 'iqr-below-minimum', signals: [] }
  const longs = ranked.slice(0, pairs)
  const shorts = ranked.slice(-pairs)
  if (!longs.every((row) => row.deviation.n < 0n) || !shorts.every((row) => row.deviation.n > 0n))
    return { ...base, reason: 'missing-opposite-extremes', signals: [] }
  const signals = [
    ...longs.map(
      ({ symbol, referenceMicros, atr14Micros }): AlphaV3NoonSignal => ({
        symbol,
        referenceMicros,
        atr14Micros,
        direction: AlphaV3Direction.Long,
      }),
    ),
    ...shorts.map(
      ({ symbol, referenceMicros, atr14Micros }): AlphaV3NoonSignal => ({
        symbol,
        referenceMicros,
        atr14Micros,
        direction: AlphaV3Direction.Short,
      }),
    ),
  ]
  return { ...base, reason: 'signal', signals }
}

const noise = (f: Features) => {
  const { policy, market, schedule, state, cutoff, observed } = f
  const checkpoint = policy.noise.checkpointMinutes * minuteMs
  return trendSymbols.map((symbol) => {
    const no = (reason: string) => ({ symbol, reason, signal: null, exit: null })
    if (
      cutoff < schedule.open + checkpoint ||
      (cutoff - schedule.open) % checkpoint !== 0 ||
      observed >= schedule.maximumHold[AlphaV3Engine.Noise]
    )
      return no('outside-checkpoint')
    const position = state.noisePositions.get(symbol)
    if (position === undefined && cutoff > schedule.noiseEntryEnd) return no('outside-entry-window')
    if (!f.active(symbol)) return no('inactive')
    const first = visible(f.today.get(symbol), 0, observed)
    const latest = visible(f.today.get(symbol), f.slot, observed)
    if (first === undefined || latest === undefined) return no('missing-current-bar')
    const prior = priorFeatures(f.history, symbol, market.session.date, observed, policy.priorSessions)
    if (prior === null || prior.trueRangeSum === 0n) return no('missing-prior-history')
    let move = { n: 0n, d: 1n }
    for (const day of prior.sessions) {
      const open = day.get(0)?.open
      const close = day.get(f.slot)?.close
      if (open === undefined || close === undefined) return no('missing-prior-checkpoint')
      move = { n: move.n * open + abs(close - open) * move.d, d: move.d * open }
    }
    if (move.n === 0n) return no('zero-noise-band')
    // 1.2× the mean absolute return. Compare before rounding displayed band boundaries.
    const width = {
      n: BigInt(policy.noise.bandMultiplier * 10) * move.n,
      d: 10n * BigInt(policy.priorSessions) * move.d,
    }
    const top = first.open > prior.previousClose ? first.open : prior.previousClose
    const bottom = first.open < prior.previousClose ? first.open : prior.previousClose
    const upper = top * (width.d + width.n)
    const lower = bottom * (width.d - width.n)
    const bands = {
      upperMicros: upper / width.d,
      lowerMicros: lower / width.d,
      bandWidthBps: ratio(10_000n * width.n, width.d),
    }
    const direction =
      latest.close * width.d > upper
        ? AlphaV3Direction.Long
        : latest.close * width.d < lower
          ? AlphaV3Direction.Short
          : null
    if (position !== undefined) {
      const exit = direction !== null && direction !== position ? { symbol, reason: 'opposite-band' as const } : null
      return { ...no(exit === null ? 'holding' : 'opposite-band'), ...bands, exit }
    }
    if (state.noiseUsed.has(symbol) || state.occupiedSymbols.has(symbol))
      return { ...no('already-used-or-occupied'), ...bands }
    if (direction === null) return { ...no('inside-bands'), ...bands }
    const signal: AlphaV3NoiseSignal = {
      symbol,
      direction,
      referenceMicros: latest.close,
      atr14Micros: prior.atr14Micros,
    }
    return { ...no('signal'), ...bands, signal }
  })
}

export const evaluateIntradayAlphaV3 = (
  policy: IntradayAlphaV3Policy,
  market: AlphaV3Market,
  state: AlphaV3SignalState,
) =>
  Result.gen(function* () {
    const session = regularBounds(market.session)
    const interval = policy.barMinutes * minuteMs
    const cutoff = Date.parse(market.cutoffAt)
    const observed = Date.parse(market.observedAt)
    if (
      session === null ||
      cutoff % interval !== 0 ||
      !Number.isFinite(observed) ||
      observed < cutoff ||
      observed >= cutoff + interval
    ) {
      return yield* Result.fail(
        new AlphaV3EvidenceError({ message: 'Invalid official session or decision cutoff/receipt' }),
      )
    }
    if (market.openingObservedAt !== null) {
      const openingObserved = Date.parse(market.openingObservedAt)
      const rangeEnd = session.open + policy.orb.openingRangeMinutes * minuteMs
      if (!Number.isFinite(openingObserved) || openingObserved < rangeEnd || openingObserved >= rangeEnd + interval) {
        return yield* Result.fail(new AlphaV3EvidenceError({ message: 'Invalid OR5 opening checkpoint receipt' }))
      }
    }
    const schedule = sessionSchedule(policy, market.session)
    const today = yield* indexBars(market.bars, session, cutoff, observed, interval)
    const history: PriorDay[] = []
    let previous = 0
    for (const { session: calendar, bars } of market.priorSessions) {
      const bounds = regularBounds(calendar)
      if (bounds === null || bounds.open <= previous || bounds.close > session.open) {
        return yield* Result.fail(
          new AlphaV3EvidenceError({ message: 'Invalid ordering or bounds of prior official sessions' }),
        )
      }
      previous = bounds.close
      history.push({
        date: calendar.date,
        bounds,
        bars: yield* indexBars(bars, bounds, bounds.close, observed, interval),
      })
    }
    const activeAtCutoff = statusAt(market.statuses, cutoff, observed, market.session.date)
    const activeAtReceipt = statusAt(market.statuses, observed, observed, market.session.date)
    const features: Features = {
      policy,
      market,
      state,
      schedule,
      cutoff,
      observed,
      today,
      history,
      slot: (cutoff - schedule.open) / interval - 1,
      active: (symbol) => activeAtCutoff(symbol) && activeAtReceipt(symbol),
    }
    const morning = orb(features)
    const midday = noon(features, morning.signal)
    const trend = noise(features)
    const entries: AlphaV3Entries = {
      [AlphaV3Engine.Orb]: morning.signal,
      [AlphaV3Engine.Reversion]: midday.signals,
      [AlphaV3Engine.Noise]: trend.flatMap(({ signal }) => (signal === null ? [] : [signal])),
    }
    return { entries, diagnostics: { orb: morning, reversion: midday, noise: trend } }
  })
