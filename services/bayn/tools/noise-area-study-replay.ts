import { mean, quantile } from './midday-research-statistics'

export const baskets = {
  B0: ['QQQ', 'SMH'],
  B1: ['SPY', 'QQQ', 'IWM', 'SMH'],
  B2: ['SPY', 'QQQ', 'IWM', 'SMH', 'TLT', 'GLD'],
  B3: ['SPY', 'QQQ', 'IWM', 'SMH', 'XLK', 'XLF', 'XLE', 'TLT', 'GLD', 'USO'],
  B4: ['SPY', 'QQQ', 'IWM', 'SMH', 'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XBI', 'ARKK', 'TLT', 'IEF', 'GLD', 'USO'],
} as const
export type Basket = keyof typeof baskets
export const basketIds = ['B0', 'B1', 'B2', 'B3', 'B4'] as const
export const symbols = baskets.B4
export type Symbol = (typeof symbols)[number]
export const costs = [1, 2, 3, 5, 10] as const
export const selectionCost = 5
export const capital = 100_000
export const cap = 180_000
const sellFee = 0.21 / 10_000
const worstFill = 1 + Math.max(...costs) / 20_000
const lookback = 14
const slotMinutes = 5
const timedExitMinutes = 15

export const splits = {
  train: { first: '2016-01-04', last: '2021-12-31', count: 1511 },
  validation: { first: '2022-01-03', last: '2023-12-29', count: 501 },
  holdout: { first: '2024-01-02', last: '2026-11-25', count: 729 },
} as const

const exits = ['opposite_band', 'vwap_or_opposite', 'band_with_1.5xATR_stop'] as const
const sizings = ['equal_weight', 'inverse_vol_parity'] as const
export interface Trial {
  readonly id: string
  readonly basket: Basket
  readonly band: 1 | 1.2 | 1.4
  readonly minutes: 15 | 30
  readonly exit: (typeof exits)[number]
  readonly sizing: (typeof sizings)[number]
  readonly legacy?: true
}

export interface Conditioning {
  readonly volatility: 'none' | 'min-vol' | 'target-vol'
  readonly confirmation: 'none' | 'rvol' | 'vwap'
  readonly stop: 'none' | 'atr' | 'breakeven'
}

const trial = (
  basket: Basket,
  minutes: Trial['minutes'],
  band: Trial['band'],
  exit: Trial['exit'],
  sizing: Trial['sizing'],
): Trial => ({ id: [basket, minutes, band, exit, sizing].join('/'), basket, minutes, band, exit, sizing })

export const grid = basketIds.flatMap((basket) =>
  exits.flatMap((exit) => [
    ...sizings.flatMap((sizing) => [trial(basket, 30, 1.2, exit, sizing), trial(basket, 15, 1.2, exit, sizing)]),
    trial(basket, 30, 1, exit, 'inverse_vol_parity'),
    trial(basket, 30, 1.4, exit, 'inverse_vol_parity'),
  ]),
)

export const legacy: Trial = {
  ...trial('B0', 30, 1.2, 'opposite_band', 'inverse_vol_parity'),
  id: 'B0/Wave5A-C5',
  legacy: true,
}

export interface Bar {
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly vwap: number
}

export interface Day {
  readonly date: string
  readonly slots: number
  readonly bars: ReadonlyMap<Symbol, readonly (Bar | undefined)[]>
}

interface Prior {
  readonly slots: number
  readonly close: number | undefined
  readonly move: readonly (number | undefined)[]
  readonly ret: number | undefined
  readonly tr: number | undefined
  readonly cumulativeVolume: readonly (number | undefined)[]
}

interface Features {
  readonly bars: readonly (Bar | undefined)[]
  readonly vwap: readonly (number | undefined)[]
  readonly bands: readonly (number | undefined)[]
  readonly previousClose: number
  readonly open: number
  readonly atr: number | undefined
  readonly vol: number | undefined
  readonly legacyBands: readonly (number | undefined)[]
  readonly legacyAtr: number | undefined
  readonly dailyReturns: readonly number[] | undefined
  readonly relativeVolume: readonly (number | undefined)[]
}

export interface Prepared {
  readonly date: string
  readonly slots: number
  readonly bySymbol: ReadonlyMap<Symbol, Features>
}

const defined = (series: readonly (number | undefined)[]): series is readonly number[] =>
  series.every((value) => value !== undefined)

export function* prepare(days: readonly Day[], members: readonly Symbol[] = symbols): Generator<Prepared> {
  const histories = new Map<Symbol, Prior[]>()
  const legacyHistories = new Map<Symbol, Prior[]>()
  for (const day of days) {
    const bySymbol = new Map<Symbol, Features>()
    for (const symbol of members) {
      const history = histories.get(symbol) ?? []
      const old = legacyHistories.get(symbol) ?? []
      const bars = day.bars.get(symbol) ?? []
      const open = bars[0]?.open
      const close = bars[day.slots - 1]?.close
      const previousClose = history.at(-1)?.close
      const recent = history.slice(-lookback)
      const returns = recent.map((row) => row.ret)
      const ranges = recent.map((row) => row.tr)
      const oldRanges = old.map((row) => row.tr)
      let volume = 0
      let dollars = 0
      let complete = true
      let high = -Infinity
      let low = Infinity
      const move: (number | undefined)[] = []
      const vwap: (number | undefined)[] = []
      const cumulativeVolume: (number | undefined)[] = []
      for (let slot = 0; slot < day.slots; slot++) {
        const bar = bars[slot]
        if (bar === undefined) complete = false
        else {
          high = Math.max(high, bar.high)
          low = Math.min(low, bar.low)
          volume += bar.volume
          dollars += bar.volume * bar.vwap
        }
        move.push(bar === undefined || open === undefined ? undefined : Math.abs(bar.close / open - 1))
        vwap.push(complete && volume > 0 ? dollars / volume : undefined)
        cumulativeVolume.push(complete ? volume : undefined)
      }

      if (open !== undefined && previousClose !== undefined) {
        const bands: (number | undefined)[] = []
        const legacyBands: (number | undefined)[] = []
        const relativeVolume: (number | undefined)[] = []
        // Index by decision bar. Exclude scheduled short sessions only at offsets they never reached.
        for (const slot of new Set([...checkpoints(day.slots, 15), ...checkpoints(day.slots, 30, true)])) {
          const eligible = history.filter((row) => row.slots > slot).slice(-lookback)
          const moves = eligible.map((row) => row.move[slot])
          bands[slot] = moves.length === lookback && defined(moves) ? mean(moves) : undefined
          const oldMoves = old.map((row) => row.move[slot])
          legacyBands[slot] = oldMoves.length === lookback && defined(oldMoves) ? mean(oldMoves) : undefined
          const volumes = eligible.map((row) => row.cumulativeVolume[slot])
          const currentVolume = cumulativeVolume[slot]
          if (currentVolume !== undefined && volumes.length === lookback && defined(volumes)) {
            const median = quantile(volumes, 0.5)
            if (median !== null && median > 0) relativeVolume[slot] = currentVolume / median
          }
        }
        let vol: number | undefined
        const dailyReturns = returns.length === lookback && defined(returns) ? returns : undefined
        if (dailyReturns !== undefined) {
          const center = mean(dailyReturns)
          let squares = 0
          for (const value of dailyReturns) squares += (value - center) ** 2
          vol = Math.max(0.001, Math.sqrt(squares / (lookback - 1)))
        }
        bySymbol.set(symbol, {
          bars,
          vwap,
          bands,
          previousClose,
          open,
          vol,
          atr: ranges.length === lookback && defined(ranges) ? mean(ranges) : undefined,
          legacyBands,
          legacyAtr: oldRanges.length === lookback && defined(oldRanges) ? mean(oldRanges) : undefined,
          dailyReturns,
          relativeVolume,
        })
      }
      const range = (ref: number) => Math.max(ref, high) - Math.min(ref, low)
      history.push({
        slots: day.slots,
        close,
        move,
        ret: open === undefined || close === undefined ? undefined : close / open - 1,
        tr: complete && open !== undefined ? range(previousClose ?? open) : undefined,
        cumulativeVolume,
      })
      // Only a finite, feature-relevant suffix is retained: fourteen observations at each checkpoint.
      if (history.length > lookback && history.slice(1).filter((row) => row.slots > 65).length >= lookback)
        history.shift()
      histories.set(symbol, history)
      if (complete && open !== undefined) {
        old.push({
          slots: day.slots,
          close,
          move,
          ret: undefined,
          tr: range(old.at(-1)?.close ?? open),
          cumulativeVolume,
        })
        if (old.length > lookback) old.shift()
      } else old.length = 0
      legacyHistories.set(symbol, old)
    }
    yield { date: day.date, slots: day.slots, bySymbol }
  }
}

export const checkpoints = (slots: number, minutes: 15 | 30, legacy = false) => {
  const last = legacy ? Math.min(330, (slots - 2) * slotMinutes) : Math.min(330, slots * slotMinutes - 30)
  const decisions = []
  for (let minute = 30; minute <= last; minute += minutes) decisions.push(minute / slotMinutes - 1)
  return decisions
}

interface Leg {
  readonly side: 1 | -1
  readonly entry: number
  readonly entrySlot: number
  readonly exit: number | undefined
  readonly maxHigh: number
  readonly missingHeld: number
}

interface Path {
  readonly leg?: Leg
  readonly missingEntry?: true
}

const weightOf = (features: Features | undefined, trial: Trial) => {
  if (features === undefined || (trial.exit === 'band_with_1.5xATR_stop' && !(Number(features.atr) > 0))) return 0
  if (trial.sizing === 'equal_weight') return 1
  return features.vol === undefined ? 0 : 1 / features.vol
}

const trace = (f: Features, spec: Trial, slots: number, conditioning?: Conditioning): Path => {
  const grid = checkpoints(slots, spec.minutes, spec.legacy)
  const flat = slots - 1
  const scheduledExit = spec.legacy === true ? flat : slots - timedExitMinutes / slotMinutes
  const bands = spec.legacy === true ? f.legacyBands : f.bands
  const upperRef = Math.max(f.open, f.previousClose)
  const lowerRef = Math.min(f.open, f.previousClose)
  const bandAt = (slot: number) => {
    const move = bands[slot]
    if (move === undefined || move <= 0) return
    return { upper: upperRef * (1 + spec.band * move), lower: lowerRef * (1 - spec.band * move) }
  }
  for (const slot of grid) {
    const band = bandAt(slot)
    const decision = f.bars[slot]
    if (band === undefined || decision === undefined) continue
    const side = decision.close > band.upper ? 1 : decision.close < band.lower ? -1 : 0
    if (side === 0) continue
    if (conditioning?.confirmation === 'rvol' && !(Number(f.relativeVolume[slot]) >= 1)) continue
    if (conditioning?.confirmation === 'vwap' && !(side * (decision.close - Number(f.vwap[slot])) > 0)) continue
    const entrySlot = slot + 1
    const entry = f.bars[entrySlot]?.open
    if (entry === undefined) return { missingEntry: true }
    const useAtr =
      spec.exit === 'band_with_1.5xATR_stop' || (conditioning !== undefined && conditioning.stop !== 'none')
    let stop = useAtr && f.atr !== undefined ? entry - side * 1.5 * f.atr : undefined
    let maxHigh = entry
    let missingHeld = 0
    let exitSlot = flat
    let requested = false
    for (let held = entrySlot; held < flat; held++) {
      const bar = f.bars[held]
      if (bar === undefined) {
        missingHeld++
        continue
      }
      if (requested || held >= scheduledExit) {
        exitSlot = held
        break
      }
      maxHigh = Math.max(maxHigh, bar.high)
      const opposing = grid.includes(held) ? bandAt(held) : undefined
      const vwap = f.vwap[held]
      requested =
        (opposing !== undefined && (side === 1 ? bar.close < opposing.lower : bar.close > opposing.upper)) ||
        (spec.exit === 'vwap_or_opposite' &&
          grid.includes(held) &&
          vwap !== undefined &&
          side * (bar.close - vwap) <= 0) ||
        (stop !== undefined && (side === 1 ? bar.low <= stop : bar.high >= stop))
      // A completed close arms the lock only for subsequent bars; OHLC cannot order a same-bar high and low.
      if (!requested && conditioning?.stop === 'breakeven' && side * (bar.close - entry) >= band.upper - band.lower)
        stop = entry
      if (requested && spec.legacy === true) {
        exitSlot = held + 1
        break
      }
    }
    const exit = f.bars[exitSlot]?.open
    return { leg: { side, entry, entrySlot, exit, maxHigh: Math.max(maxHigh, exit ?? 0), missingHeld } }
  }
  return {}
}

export interface Ledger {
  readonly base: number
  readonly slope: number
  readonly trades: number
  readonly unresolved: number
  readonly missingEntries: number
  readonly missingHeld: number
  readonly grossUpperBound: number
}
export const netAt = (row: Ledger, bp: number) => (row.unresolved > 0 ? null : row.base - bp * row.slope)

// Paths do not depend on basket allocation; reuse them for same-day basket and omission diagnostics.
export const createReplay = (day: Prepared) => {
  const paths = new Map<string, Path>()
  return (spec: Trial, members: readonly Symbol[] = baskets[spec.basket], conditioning?: Conditioning): Ledger => {
    const weighted = members.map((symbol) => ({ symbol, weight: weightOf(day.bySymbol.get(symbol), spec) }))
    const totalWeight = weighted.reduce((sum, { weight }) => sum + weight, 0)
    let grossScale = 1
    if (conditioning?.volatility === 'target-vol') {
      const portfolioReturns = Array<number>(lookback).fill(0)
      for (const { symbol, weight } of weighted) {
        const returns = day.bySymbol.get(symbol)?.dailyReturns
        if (weight === 0 || returns === undefined) {
          grossScale = 0
          break
        }
        returns.forEach((value, i) => (portfolioReturns[i] += (weight / totalWeight) * value))
      }
      const center = mean(portfolioReturns)
      const annualVol = Math.sqrt(
        portfolioReturns.reduce((sum, value) => sum + (value - center) ** 2, 0) * (252 / (lookback - 1)),
      )
      if (annualVol > 0.1) grossScale *= 0.1 / annualVol
    }
    let base = 0
    let slope = 0
    let trades = 0
    let unresolved = 0
    let missingEntries = 0
    let missingHeld = 0
    // Sum of per-leg peak marks bounds the concurrent 5m high, even if the peaks occurred at different times.
    let grossUpperBound = 0
    for (const { symbol, weight } of weighted) {
      const features = day.bySymbol.get(symbol)
      if (features === undefined || (spec.legacy === true ? !(Number(features.legacyAtr) > 0) : weight <= 0)) continue
      // Withheld names leave their allocation idle rather than increasing another name's exposure.
      if (grossScale === 0 || (conditioning?.volatility === 'min-vol' && !(Number(features.vol) >= 0.006))) continue
      if (conditioning !== undefined && conditioning.stop !== 'none' && !(Number(features.atr) > 0)) continue
      const key = [
        symbol,
        spec.minutes,
        spec.band,
        spec.exit,
        spec.legacy === true,
        conditioning?.confirmation,
        conditioning?.stop,
      ].join('/')
      let path = paths.get(key)
      if (path === undefined) {
        path = trace(features, spec, day.slots, conditioning)
        paths.set(key, path)
      }
      if (path.missingEntry === true) missingEntries++
      const { leg } = path
      if (leg === undefined) continue
      const budget = spec.legacy === true ? 60_000 : (capital * weight * grossScale) / totalWeight
      const legacyAtr = features.legacyAtr
      const reference = features.bars[leg.entrySlot - 1]?.close
      const quantity = Math.floor(
        Math.min(
          budget / (leg.entry * worstFill),
          spec.legacy === true ? Infinity : reference === undefined ? 0 : budget / reference,
          spec.legacy === true && legacyAtr !== undefined ? 1500 / (2 * legacyAtr) : Infinity,
        ),
      )
      if (quantity === 0) continue
      grossUpperBound += quantity * leg.maxHigh * worstFill
      missingHeld += leg.missingHeld
      if (leg.exit === undefined) {
        unresolved++
        continue
      }
      const sell = leg.side === 1 ? leg.exit : leg.entry
      base += quantity * (leg.side * (leg.exit - leg.entry) - sell * sellFee)
      slope += (quantity * (leg.entry + leg.exit - sell * sellFee)) / 20_000
      trades++
    }
    return { base, slope, trades, unresolved, missingEntries, missingHeld, grossUpperBound }
  }
}
