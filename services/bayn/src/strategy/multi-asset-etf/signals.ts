import { Result } from 'effect'

import type { MarketCalendarObservation } from '../../broker/alpaca/model'
import { marketHoursAreCanonical } from '../../market-hours'
import type { TargetPortfolio } from '../core'
import {
  multiAssetEtfs,
  multiAssetEtfTradables,
  sleeveNames,
  type EtfSleeve,
  type EtfWeights,
  type MultiAssetEtf,
  type MultiAssetEtfPolicy,
  type MultiAssetEtfTradable,
} from './policy'

export interface AdjustedEtfBar {
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

export interface MultiAssetEtfMarket {
  /** Complete, verified Alpaca exchange calendar; include both boundary months in full. */
  readonly calendar: MarketCalendarObservation
  readonly executionSession: string
  readonly adjustment: 'all'
  readonly adjustmentAsOfSession: string
  readonly barsBySession: Readonly<Partial<Record<string, Readonly<Partial<Record<MultiAssetEtf, AdjustedEtfBar>>>>>>
}

export interface MissingSymbolBar {
  readonly _tag: 'MissingSymbolBar'
  readonly symbol: MultiAssetEtf
  readonly session: string
}

export type MultiAssetEtfSignalFailure =
  | MissingSymbolBar
  | { readonly _tag: 'InsufficientHistory'; readonly availableSessions: number; readonly requiredSessions: number }
  | { readonly _tag: 'InvalidCalendar'; readonly executionSession: string }
  | { readonly _tag: 'InvalidHistory'; readonly expectedAdjustmentAsOfSession: string }
  | { readonly _tag: 'InvalidSymbolBar'; readonly symbol: MultiAssetEtf; readonly session: string }

export interface EtfSleeveAttribution {
  readonly sleeveWeights: EtfWeights
  readonly portfolioContribution: EtfWeights
}

export interface MultiAssetEtfSignal extends TargetPortfolio {
  readonly policyHash: string
  readonly signalSession: string
  readonly executionSession: string
  readonly sleeveAttribution: Readonly<Record<EtfSleeve, EtfSleeveAttribution>>
  readonly idleCashContribution: EtfWeights
  /** An excluded symbol is not a flat target. The planner must not resize its position. */
  readonly exclusions: readonly MissingSymbolBar[]
  readonly targetWeights: EtfWeights
}

type Book = Partial<Record<MultiAssetEtfTradable, number>>
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
const volatility = (values: readonly number[], annualization: number) => {
  const center = mean(values)
  return Math.sqrt(
    (values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1)) * annualization,
  )
}
const gross = (weights: EtfWeights) => Object.values(weights).reduce((sum, weight) => sum + Math.abs(weight), 0)
const scaled = (weights: EtfWeights, factor: number): Book => {
  const result: Book = {}
  for (const symbol of multiAssetEtfTradables) {
    const weight = (weights[symbol] ?? 0) * factor
    if (weight !== 0) result[symbol] = weight
  }
  return result
}

const validBar = ({ open, high, low, close, volume }: AdjustedEtfBar) =>
  // Bound numerical inputs so even ratios and squared returns stay finite.
  [open, high, low, close].every((price) => price >= Number.EPSILON && price <= Number.MAX_SAFE_INTEGER) &&
  low <= Math.min(open, close) &&
  Math.max(open, close) <= high &&
  Number.isFinite(volume) &&
  volume >= 0

const monthStart = (day: string) => `${day.slice(0, 7)}-01`
const monthEnd = (day: string) => {
  const date = new Date(`${monthStart(day)}T00:00:00.000Z`)
  date.setUTCMonth(date.getUTCMonth() + 1, 0)
  return date.toISOString().slice(0, 10)
}

interface SessionOffsets {
  readonly date: string
  readonly fromStart: number
  readonly toEnd: number
  readonly monthBase: number
}

const sessionClock = (policy: MultiAssetEtfPolicy, market: MultiAssetEtfMarket) =>
  Result.gen(function* () {
    const { calendar, executionSession } = market
    const invalid = { _tag: 'InvalidCalendar', executionSession } as const
    const sessions = calendar.providerSessions
    const execution = sessions.findIndex(({ date }) => date === executionSession)
    const start = sessions.findIndex(({ date }) => date === policy.historyStartSession)
    if (
      start < 0 ||
      execution <= start ||
      calendar.requestedRange.start > monthStart(policy.historyStartSession) ||
      calendar.requestedRange.end < monthEnd(executionSession) ||
      !marketHoursAreCanonical(calendar)
    )
      return yield* Result.fail(invalid)
    const offsets: SessionOffsets[] = []
    for (let first = 0; first < sessions.length; ) {
      const month = sessions[first]?.date.slice(0, 7)
      let last = first
      while (last + 1 < sessions.length && sessions[last + 1]?.date.slice(0, 7) === month) last++
      for (let index = first; index <= last; index++) {
        const row = sessions[index]
        const previous = sessions[index - 1]
        if (
          row === undefined ||
          (previous !== undefined && previous.date >= row.date) ||
          row.date < calendar.requestedRange.start ||
          row.date > calendar.requestedRange.end
        )
          return yield* Result.fail(invalid)
        if (index >= start && index < execution) {
          offsets.push({
            date: row.date,
            fromStart: index - first + 1,
            toEnd: index - last,
            monthBase: first - 1 - start,
          })
        }
      }
      first = last + 1
    }
    const signalSession = sessions[execution - 1]?.date
    if (signalSession === undefined) return yield* Result.fail(invalid)
    return { offsets, signalSession }
  })

interface Track {
  readonly closes: (number | undefined)[]
  lastMissing: MissingSymbolBar | undefined
  changes: number
  gains: number
  losses: number
}

const addClose = (track: Track, close: number | undefined, missing: MissingSymbolBar) => {
  const previous = track.closes.at(-1)
  track.closes.push(close)
  if (close === undefined) track.lastMissing = missing
  if (previous === undefined || close === undefined) {
    track.changes = track.gains = track.losses = 0
    return
  }
  const change = close - previous
  const gain = Math.max(0, change)
  const loss = Math.max(0, -change)
  track.gains = track.changes === 0 ? gain : (track.gains + gain) / 2
  track.losses = track.changes === 0 ? loss : (track.losses + loss) / 2
  track.changes++
}

interface Features {
  readonly close: number
  readonly closes: readonly number[]
  readonly daily: readonly number[]
  readonly vol: number
  readonly rsi: number | null
}

const features = (track: Track | undefined, count: number, policy: MultiAssetEtfPolicy): Features | undefined => {
  if (track === undefined) return undefined
  const days = Math.max(count, policy.volatilityLookbackSessions + 1)
  if (track.closes.length < days) return undefined
  const closes = track.closes.slice(-days)
  const current = closes.at(-1)
  if (current === undefined || !closes.every((close) => close !== undefined)) return undefined
  const daily: number[] = []
  for (let i = closes.length - policy.volatilityLookbackSessions; i < closes.length; i++) {
    const before = closes[i - 1]
    const after = closes[i]
    if (before === undefined || after === undefined) return undefined
    daily.push(after / before - 1)
  }
  const vol = volatility(daily, policy.annualizationSessions)
  const movements = track.gains + track.losses
  return {
    close: current,
    closes,
    daily,
    vol,
    rsi:
      track.changes < policy.sleeves.pullback.rsiSessions
        ? null
        : movements === 0
          ? 50
          : 100 * (track.gains / movements),
  }
}

interface VolLeg {
  readonly symbol: MultiAssetEtf
  readonly direction: number
  readonly feature: Features
}

const sleeveCap = (book: EtfWeights, policy: MultiAssetEtfPolicy) => {
  const exposure = gross(book)
  return exposure > policy.sleeveGrossCap ? scaled(book, policy.sleeveGrossCap / exposure) : book
}

const volTarget = (legs: readonly VolLeg[], annualVolatility: number, policy: MultiAssetEtfPolicy): EtfWeights => {
  // Normalize inverse-vol weights first, so small individual vols never inflate the covariance calculation.
  const minVol = Math.min(...legs.map(({ feature }) => feature.vol))
  const relative = legs.map(({ feature, direction, symbol }) => ({
    symbol,
    feature,
    strength: (direction * minVol) / feature.vol,
  }))
  const total = relative.reduce((sum, { strength }) => sum + Math.abs(strength), 0)
  if (total === 0) return {}
  const normalized = relative.map(({ symbol, feature, strength }) => ({
    symbol,
    weight: strength / total,
    daily: feature.daily,
  }))
  const daily = Array.from({ length: policy.volatilityLookbackSessions }, () => 0)
  for (const leg of normalized) {
    for (const [i, value] of leg.daily.entries()) daily[i] = (daily[i] ?? 0) + leg.weight * value
  }
  const vol = volatility(daily, policy.annualizationSessions)
  if (!(vol > 0)) return {}
  const factor = Math.min(policy.sleeveGrossCap, annualVolatility / vol)
  const result: Book = {}
  for (const { symbol, weight } of normalized) {
    if (weight !== 0) result[symbol] = weight * factor
  }
  return result
}

const missingBar = (symbol: MultiAssetEtf, session: string): MissingSymbolBar => ({
  _tag: 'MissingSymbolBar',
  symbol,
  session,
})

export const capEtfPortfolio = (weights: EtfWeights, policy: MultiAssetEtfPolicy): Book => {
  const { maxGrossLeverage, maxSingleSymbolWeight, maxNetShortWeight } = policy.risk
  const book: Book = {}
  let longs = 0
  let shorts = 0
  for (const symbol of multiAssetEtfTradables) {
    const weight = Math.max(-maxSingleSymbolWeight, Math.min(maxSingleSymbolWeight, weights[symbol] ?? 0))
    if (weight === 0) continue
    book[symbol] = weight
    if (weight > 0) longs += weight
    else shorts -= weight
  }
  const shortScale = shorts > longs + maxNetShortWeight ? (longs + maxNetShortWeight) / shorts : 1
  for (const symbol of multiAssetEtfTradables) {
    const weight = book[symbol]
    if (weight === undefined || weight >= 0) continue
    if (shortScale === 0) delete book[symbol]
    else book[symbol] = weight * shortScale
  }
  const exposure = gross(book)
  return exposure > maxGrossLeverage ? scaled(book, maxGrossLeverage / exposure) : book
}

const aggregate = (
  policy: MultiAssetEtfPolicy,
  sleeves: Readonly<Record<EtfSleeve, EtfWeights>>,
  exclusions: readonly MissingSymbolBar[],
) => {
  const blocked = new Set<MultiAssetEtfTradable>(exclusions.map(({ symbol }) => symbol))
  const net: Book = {}
  for (const symbol of multiAssetEtfTradables) {
    if (blocked.has(symbol)) continue
    const desired = sleeveNames.reduce(
      (sum, sleeve) => sum + (sleeves[sleeve][symbol] ?? 0) * policy.sleeves[sleeve].capitalWeight,
      0,
    )
    if (desired !== 0) net[symbol] = desired
  }
  const capped = capEtfPortfolio(net, policy)
  const attribute = (sleeve: EtfSleeve): EtfSleeveAttribution => {
    const contribution: Book = {}
    for (const symbol of multiAssetEtfTradables) {
      const weight = sleeves[sleeve][symbol]
      if (weight === undefined || blocked.has(symbol)) continue
      const before = net[symbol] ?? 0
      const factor = before === 0 ? 1 : (capped[symbol] ?? 0) / before
      const effective = weight * policy.sleeves[sleeve].capitalWeight * factor
      if (effective !== 0) contribution[symbol] = effective
    }
    return { sleeveWeights: sleeves[sleeve], portfolioContribution: contribution }
  }
  const sleeveAttribution = {
    trend: attribute('trend'),
    rotation: attribute('rotation'),
    pension: attribute('pension'),
    turnOfMonth: attribute('turnOfMonth'),
    pullback: attribute('pullback'),
  }
  const idleCashContribution: Book = {}
  if (policy.idleCashSweep.enabled) {
    const { symbol } = policy.idleCashSweep
    const existing = capped[symbol] ?? 0
    const idle = Math.min(1, policy.risk.maxGrossLeverage) - gross(capped)
    const sweep = Math.min(idle, policy.risk.maxSingleSymbolWeight - existing)
    if (existing >= 0 && !blocked.has(symbol) && sweep > 0) {
      idleCashContribution[symbol] = sweep
      capped[symbol] = existing + sweep
    }
  }
  return { targetWeights: capped, sleeveAttribution, idleCashContribution }
}

/** Reconstruct state from the policy-pinned first close; never read a bar on or after the execution session. */
export const compileMultiAssetEtfSignal = (
  policy: MultiAssetEtfPolicy,
  market: MultiAssetEtfMarket,
): Result.Result<MultiAssetEtfSignal, MultiAssetEtfSignalFailure> =>
  Result.gen(function* () {
    const { offsets, signalSession } = yield* sessionClock(policy, market)
    const requiredSessions = policy.sleeves.trend.momentumSessions + 1
    if (offsets.length < requiredSessions)
      return yield* Result.fail({
        _tag: 'InsufficientHistory',
        availableSessions: offsets.length,
        requiredSessions,
      } as const)
    if (market.adjustment !== 'all' || market.adjustmentAsOfSession !== signalSession)
      return yield* Result.fail({
        _tag: 'InvalidHistory',
        expectedAdjustmentAsOfSession: signalSession,
      } as const)

    const tracks = new Map<MultiAssetEtf, Track>()
    for (const symbol of multiAssetEtfs)
      tracks.set(symbol, { closes: [], lastMissing: undefined, changes: 0, gains: 0, losses: 0 })
    const books: Record<EtfSleeve, EtfWeights> = { trend: {}, rotation: {}, pension: {}, turnOfMonth: {}, pullback: {} }
    const trendExclusions = new Map<MultiAssetEtf, MissingSymbolBar>()
    const rotationExclusions = new Map<MultiAssetEtf, MissingSymbolBar>()
    const tomExclusions = new Map<MultiAssetEtf, MissingSymbolBar>()
    const pullbackExclusions = new Map<MultiAssetEtf, MissingSymbolBar>()
    const entries = new Map<MultiAssetEtf, { readonly day: number; readonly weight: number }>()
    let gateFailure: MissingSymbolBar | undefined
    let pensionFailure: MissingSymbolBar | undefined

    for (const [i, session] of offsets.entries()) {
      const bars = market.barsBySession[session.date]
      for (const [symbol, track] of tracks) {
        const bar = bars?.[symbol]
        if (bar !== undefined && !validBar(bar))
          return yield* Result.fail({ _tag: 'InvalidSymbolBar', symbol, session: session.date } as const)
        addClose(track, bar?.close, missingBar(symbol, session.date))
      }
      const read = (symbol: MultiAssetEtf, count: number, exclusions: Map<MultiAssetEtf, MissingSymbolBar>) => {
        const track = tracks.get(symbol)
        const feature = features(track, count, policy)
        if (feature === undefined && track?.lastMissing !== undefined) exclusions.set(symbol, track.lastMissing)
        return feature
      }
      const { trend, rotation, pension, turnOfMonth, pullback } = policy.sleeves
      if (i % policy.refreshEverySessions === 0) {
        if (trend.capitalWeight > 0) {
          trendExclusions.clear()
          const legs: VolLeg[] = []
          for (const symbol of trend.symbols) {
            const feature = read(symbol, trend.momentumSessions + 1, trendExclusions)
            const past = feature?.closes[0]
            if (feature !== undefined && past !== undefined && feature.vol > 0 && feature.close !== past) {
              legs.push({ symbol, feature, direction: Math.sign(feature.close - past) })
            }
          }
          const desired = volTarget(legs, trend.annualVolatility, policy)
          const buffered: Book = {}
          for (const symbol of trend.symbols) {
            const next = desired[symbol] ?? 0
            const previous = books.trend[symbol] ?? 0
            if (next !== 0)
              buffered[symbol] =
                Math.sign(next) === Math.sign(previous) && Math.abs(next - previous) < trend.targetBuffer
                  ? previous
                  : next
          }
          books.trend = sleeveCap(buffered, policy)
        }
        if (rotation.capitalWeight > 0) {
          rotationExclusions.clear()
          const gate = read(rotation.gateSymbol, rotation.gateSmaSessions, rotationExclusions)
          gateFailure = rotationExclusions.get(rotation.gateSymbol)
          rotationExclusions.clear()
          const rotationBook: Book = {}
          if (gate !== undefined) {
            const pool = gate.close > mean(gate.closes) ? rotation.riskOnSymbols : rotation.riskOffSymbols
            const ranked = pool.flatMap((symbol) => {
              const feature = read(symbol, rotation.momentumSessions + 1, rotationExclusions)
              const past = feature?.closes[0]
              return feature !== undefined && past !== undefined && feature.vol > 0 && feature.close > past
                ? [{ symbol, score: (feature.close / past - 1) / feature.vol }]
                : []
            })
            ranked.sort((a, b) => b.score - a.score)
            for (const { symbol } of ranked.slice(0, rotation.picks)) rotationBook[symbol] = 1 / rotation.picks
          }
          books.rotation = rotationBook
        }
      }

      if (pension.capitalWeight > 0) {
        if (session.toEnd === 0) {
          books.pension = {}
          pensionFailure = undefined
        } else if (session.toEnd === pension.signalSessionsFromMonthEnd && session.monthBase >= 0) {
          const spy = tracks.get('SPY')?.closes
          const tlt = tracks.get('TLT')?.closes
          const baseSession = offsets[session.monthBase]?.date ?? session.date
          const [spyClose, tltClose, spyBase, tltBase] = [
            spy?.[i],
            tlt?.[i],
            spy?.[session.monthBase],
            tlt?.[session.monthBase],
          ]
          if (spyClose === undefined) pensionFailure = missingBar('SPY', session.date)
          else if (tltClose === undefined) pensionFailure = missingBar('TLT', session.date)
          else if (spyBase === undefined) pensionFailure = missingBar('SPY', baseSession)
          else if (tltBase === undefined) pensionFailure = missingBar('TLT', baseSession)
          else {
            const spread = spyClose / spyBase - tltClose / tltBase
            if (Math.abs(spread) >= pension.minimumSpread) books.pension = spread > 0 ? { TLT: 1 } : { SPY: 1 }
          }
        }
      }

      if (turnOfMonth.capitalWeight > 0) {
        if (session.fromStart === turnOfMonth.throughSessionOfNextMonth) {
          books.turnOfMonth = {}
          tomExclusions.clear()
        }
        if (session.toEnd === turnOfMonth.entrySessionsFromMonthEnd - 1) {
          tomExclusions.clear()
          const legs: VolLeg[] = []
          for (const symbol of ['SPY', 'QQQ'] as const) {
            const feature = read(symbol, policy.volatilityLookbackSessions + 1, tomExclusions)
            if (feature !== undefined && feature.vol > 0) legs.push({ symbol, feature, direction: 1 })
          }
          books.turnOfMonth = volTarget(legs, turnOfMonth.annualVolatility, policy)
        }
      }

      if (pullback.capitalWeight > 0) {
        pullbackExclusions.clear()
        const ranked: { symbol: MultiAssetEtf; vol: number; rsi: number }[] = []
        for (const symbol of pullback.symbols) {
          const feature = read(symbol, pullback.trendSmaSessions, pullbackExclusions)
          const entry = entries.get(symbol)
          const rsi = feature?.rsi
          if (entry !== undefined) {
            if (i - entry.day >= pullback.maximumHeldSessions || (rsi != null && rsi > pullback.exitAboveRsi))
              entries.delete(symbol)
          } else if (
            feature !== undefined &&
            rsi != null &&
            feature.close > mean(feature.closes) &&
            feature.vol > 0 &&
            rsi < pullback.entryBelowRsi
          ) {
            ranked.push({ symbol, vol: feature.vol, rsi })
          }
        }
        ranked.sort((a, b) => a.rsi - b.rsi)
        for (const { symbol, vol } of ranked.slice(0, pullback.maximumPositions - entries.size)) {
          entries.set(symbol, {
            day: i,
            weight: Math.min(pullback.maximumWeightPerPosition, pullback.annualVolatilityPerPosition / vol),
          })
        }
        books.pullback = Object.fromEntries([...entries].map(([symbol, entry]) => [symbol, entry.weight]))
      }
    }
    const gateSymbol = policy.sleeves.rotation.gateSymbol
    const gateMissingNow =
      policy.sleeves.rotation.capitalWeight > 0 && tracks.get(gateSymbol)?.closes.at(-1) === undefined
    const requiredFailure =
      pensionFailure ?? gateFailure ?? (gateMissingNow ? missingBar(gateSymbol, signalSession) : undefined)
    if (requiredFailure !== undefined) return yield* Result.fail(requiredFailure)

    const exclusions = [
      ...trendExclusions.values(),
      ...rotationExclusions.values(),
      ...tomExclusions.values(),
      ...pullbackExclusions.values(),
    ]
    for (const [symbol, track] of tracks) {
      if (track.closes.at(-1) === undefined) exclusions.push(missingBar(symbol, signalSession))
    }
    const latestBySymbol = new Map<MultiAssetEtf, MissingSymbolBar>()
    for (const failure of exclusions) {
      const previous = latestBySymbol.get(failure.symbol)
      if (previous === undefined || previous.session < failure.session) latestBySymbol.set(failure.symbol, failure)
    }
    const ordered = multiAssetEtfs.flatMap((symbol) => {
      const failure = latestBySymbol.get(symbol)
      return failure === undefined ? [] : [failure]
    })
    return {
      ...aggregate(policy, books, ordered),
      exclusions: ordered,
      policyHash: policy.policyHash,
      executionSession: market.executionSession,
      signalSession,
    }
  })
