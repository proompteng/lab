import { stride, type TapeDay } from './research-sip-momentum-data'
import {
  costs,
  equity,
  etfs,
  grossCap,
  historySessions,
  sellFee,
  stocks,
  symbols,
  universes,
  type Noise,
  type Orb,
  type Trial,
} from './research-sip-momentum-protocol'

type Side = 1 | -1
const open = (bars: Float64Array, i: number) => bars[i * stride]
const high = (bars: Float64Array, i: number) => bars[i * stride + 1]
const low = (bars: Float64Array, i: number) => bars[i * stride + 2]
const close = (bars: Float64Array, i: number) => bars[i * stride + 3]
const direction = (first: number, last: number): Side | null => (last > first ? 1 : last < first ? -1 : null)

const range = (bars: Float64Array, slots: number) => {
  let lo = Infinity
  let hi = 0
  let volume = 0
  for (let i = 0; i < slots; i++) {
    if (open(bars, i) === 0) return null
    lo = Math.min(lo, low(bars, i))
    hi = Math.max(hi, high(bars, i))
    volume += bars[i * stride + 4]
  }
  return { lo, hi, volume, side: direction(open(bars, 0), close(bars, slots - 1)) }
}

const checkpoints = Array.from({ length: 12 }, (_, i) => 6 * (i + 1) - 1)

interface Prior {
  readonly close: number
  readonly tr: number | null
  readonly vol5: number | null
  readonly vol15: number | null
  readonly moves: readonly (number | null)[]
}

const mean14 = (history: readonly (Prior | null)[], read: (prior: Prior) => number | null): number | null => {
  if (history.length !== historySessions) return null
  let total = 0
  for (const prior of history) {
    const value = prior === null ? null : read(prior)
    if (value === null) return null
    total += value
  }
  return total / historySessions
}

interface Features {
  readonly bars: Float64Array
  readonly atr: number
  readonly prevClose: number
  readonly ranges: Readonly<Partial<Record<Orb['rangeBars'], { lo: number; hi: number; side: Side; rvol: number }>>>
  readonly moves: ReadonlyMap<number, number>
}

interface Ranked {
  readonly symbol: string
  readonly range: NonNullable<Features['ranges'][1]>
  readonly features: Features
}

export interface PreparedDay {
  readonly date: string
  readonly slots: number
  readonly features: ReadonlyMap<string, Features>
  readonly ranked: Readonly<Record<Orb['rangeBars'], readonly Ranked[]>>
  readonly fills: Map<string, Fill | null>
}

export const prepare = (days: readonly TapeDay[]): readonly PreparedDay[] => {
  const histories = new Map<string, (Prior | null)[]>()
  const etfSet = new Set(etfs)
  return days.map(({ date, slots, bars }): PreparedDay => {
    const features = new Map<string, Features>()
    for (const symbol of symbols) {
      let history = histories.get(symbol) ?? []
      // WDC is economically discontinuous across the Sandisk distribution (not a simple split).
      if (symbol === 'WDC' && date === '2025-02-24') history = []
      const today = bars.get(symbol)
      const prevClose = history.at(-1)?.close ?? 0
      let prior: Prior | null = null
      if (today !== undefined) {
        const first = open(today, 0)
        const last = close(today, slots - 1)
        const full = range(today, slots)
        const opening5 = range(today, 1)
        const opening15 = range(today, 3)
        const atr = mean14(history, (past) => past.tr)
        const isEtf = etfSet.has(symbol)
        const ranges: Partial<Record<Orb['rangeBars'], NonNullable<Features['ranges'][1]>>> = {}
        const moves = new Map<number, number>()
        if (atr !== null && atr > 0 && prevClose > 0 && first > 0) {
          if (isEtf) {
            for (const [j, i] of checkpoints.entries()) {
              if (i >= slots - 2) break
              const value = mean14(history, (past) => past.moves[j] ?? null)
              if (value !== null && value > 0) moves.set(i, value)
            }
          } else {
            for (const [width, current, volume] of [
              [1, opening5, mean14(history, (past) => past.vol5)],
              [3, opening15, mean14(history, (past) => past.vol15)],
            ] as const) {
              if (current !== null && current.side !== null && volume !== null && volume > 0) {
                ranges[width] = { lo: current.lo, hi: current.hi, side: current.side, rvol: current.volume / volume }
              }
            }
          }
          features.set(symbol, { bars: today, atr, prevClose, ranges, moves })
        }
        prior = {
          close: last,
          tr:
            full === null
              ? null
              : prevClose > 0
                ? Math.max(full.hi, prevClose) - Math.min(full.lo, prevClose)
                : history.every((past) => past === null)
                  ? full.hi - full.lo
                  : null,
          vol5: opening5?.volume ?? null,
          vol15: opening15?.volume ?? null,
          moves: isEtf
            ? checkpoints.map((i) =>
                first > 0 && i < slots && close(today, i) > 0 ? Math.abs(close(today, i) / first - 1) : null,
              )
            : [],
        }
      }
      history.push(prior)
      if (history.length > historySessions) history.shift()
      histories.set(symbol, history)
    }
    const rank = (width: Orb['rangeBars']) =>
      stocks
        .flatMap((symbol): Ranked[] => {
          const f = features.get(symbol)
          const r = f?.ranges[width]
          return f !== undefined && r !== undefined && r.rvol >= 1.5 ? [{ symbol, range: r, features: f }] : []
        })
        .sort((a, b) => b.range.rvol - a.range.rvol || a.symbol.localeCompare(b.symbol, 'en'))
    return { date, slots, features, ranked: { 1: rank(1), 3: rank(3) }, fills: new Map() }
  })
}

interface Entry {
  readonly signal: number
  readonly side: Side
  readonly stop: { readonly at: number } | { readonly distance: number } | null
  readonly targetR: number | null
  readonly exitAt?: ((bar: number) => boolean) | undefined
}

type Fill =
  | {
      readonly side: Side
      readonly entry: number
      readonly sizingDistance: number
      readonly reference: number
      readonly exit: number | null
    }
  | 'missingEntry'

export const simulateFill = (bars: Float64Array, slots: number, entry: Entry, sizingDistance?: number): Fill | null => {
  const start = entry.signal + 1
  const flatten = slots - 1
  if (start >= flatten) return null
  const price = open(bars, start)
  if (price === 0) return 'missingEntry'
  const { side } = entry
  const stop = entry.stop === null ? null : 'at' in entry.stop ? entry.stop.at : price - side * entry.stop.distance
  const risk = stop === null ? null : side * (price - stop)
  // An open already beyond the absolute bracket cannot be protected by that bracket.
  if (stop !== null && (stop <= 0 || side * (price - stop) <= 0)) return null
  const distance = sizingDistance ?? risk
  if (distance === null || distance <= 0) throw new Error('Missing sizing distance')
  const target = entry.targetR === null || risk === null ? null : price + side * risk * entry.targetR
  let exit: number | null = null
  let pendingExit = false
  for (let i = start; i <= flatten; i++) {
    const mark = open(bars, i)
    // An active position with a gap in observations has an unknown path, including a missing timed exit.
    if (mark === 0) break
    if (i === flatten || pendingExit) {
      exit = mark
      break
    }
    if (stop !== null && side * (mark - stop) <= 0) {
      exit = mark
      break
    }
    if (target !== null && side * (mark - target) >= 0) {
      exit = target // No favorable price improvement on target orders.
      break
    }
    const adverse = side === 1 ? low(bars, i) : high(bars, i)
    const favorable = side === 1 ? high(bars, i) : low(bars, i)
    if (stop !== null && side * (adverse - stop) <= 0) {
      exit = stop
      break
    }
    if (target !== null && side * (favorable - target) >= 0) {
      exit = target
      break
    }
    pendingExit = entry.exitAt?.(i) ?? false
  }
  return { side, entry: price, exit, sizingDistance: distance, reference: close(bars, entry.signal) }
}

const orbFilters = (day: PreparedDay, trial: Orb, candidate: Ranked) => {
  const { side } = candidate.range
  const { bars, prevClose, atr } = candidate.features
  if (trial.filter === 'gap') return Math.abs(open(bars, 0) - prevClose) >= 0.5 * atr
  if (trial.filter === 'none') return true
  const spy = day.features.get('SPY')?.bars
  return (
    spy !== undefined &&
    close(spy, trial.rangeBars - 1) > 0 &&
    direction(open(spy, 0), close(spy, trial.rangeBars - 1)) === side
  )
}

const cached = (day: PreparedDay, key: string, simulate: () => Fill | null): Fill | null => {
  const result = day.fills.get(key)
  if (result !== undefined) return result
  const next = simulate()
  day.fills.set(key, next)
  return next
}

const orbFill = (day: PreparedDay, trial: Orb, candidate: Ranked) =>
  cached(day, `${candidate.symbol}/${trial.rangeBars}/${trial.stop}/${trial.target}`, () => {
    const { bars, atr } = candidate.features
    const { side, hi, lo } = candidate.range
    const edge = side === 1 ? hi : lo
    const stop = trial.stop === 'range' ? { at: side === 1 ? lo : hi } : { distance: trial.stop * atr }
    for (let i = trial.rangeBars; i < day.slots - 2; i++) {
      // Completed-bar touch is the earliest causal approximation of the paper's breakout stop entry.
      if (open(bars, i) === 0 || side * ((side === 1 ? high(bars, i) : low(bars, i)) - edge) <= 0) continue
      const reference = close(bars, i)
      const distance = 'at' in stop ? side * (reference - stop.at) : stop.distance
      if (distance <= 0) return null
      return simulateFill(
        bars,
        day.slots,
        {
          signal: i,
          side,
          stop,
          targetR: trial.target === 'eod' ? null : trial.target,
        },
        distance,
      )
    }
    return null
  })

export const noiseBands = (todayOpen: number, priorClose: number, move: number, multiplier: number) => {
  const width = multiplier * move
  return { upper: Math.max(todayOpen, priorClose) * (1 + width), lower: Math.min(todayOpen, priorClose) * (1 - width) }
}

const noiseFill = (day: PreparedDay, trial: Noise, symbol: string) =>
  cached(day, `${symbol}/${trial.checkpoint}/${trial.band}/${trial.exit}`, () => {
    const features = day.features.get(symbol)
    if (features === undefined) return null
    const { bars, atr, prevClose, moves } = features
    const sideAt = (i: number) => {
      const move = moves.get(i)
      if (move === undefined || open(bars, i) === 0) return null
      const { upper, lower } = noiseBands(open(bars, 0), prevClose, move, trial.band)
      const price = close(bars, i)
      return price > upper ? 1 : price < lower ? -1 : null
    }
    for (let i = trial.checkpoint - 1; i < day.slots - 2; i += trial.checkpoint) {
      const side = sideAt(i)
      if (side === null) continue
      return simulateFill(
        bars,
        day.slots,
        {
          signal: i,
          side,
          stop: trial.exit === 'atr' ? { distance: 1.5 * atr } : null,
          targetR: null,
          exitAt:
            trial.exit === 'opposite'
              ? (bar) => (bar + 1) % trial.checkpoint === 0 && sideAt(bar) === -side
              : undefined,
        },
        atr,
      )
    }
    return null
  })

export interface Daily {
  netBeforeSlippage: number
  turnoverAfterFee: number
  entryNotional: number
  trades: number
  unresolved: number
  missingEntry: number
}
export const cash = (): Daily => ({
  netBeforeSlippage: 0,
  turnoverAfterFee: 0,
  entryNotional: 0,
  trades: 0,
  unresolved: 0,
  missingEntry: 0,
})

const add = (total: Daily, leg: Daily, sign = 1) => {
  total.netBeforeSlippage += sign * leg.netBeforeSlippage
  total.turnoverAfterFee += sign * leg.turnoverAfterFee
  total.entryNotional += sign * leg.entryNotional
  total.trades += sign * leg.trades
  total.unresolved += sign * leg.unresolved
  total.missingEntry += sign * leg.missingEntry
}

export const netAt = (daily: Daily, bps: number) => daily.netBeforeSlippage - (daily.turnoverAfterFee * bps) / 20_000

const account = (fill: Fill | null, risk: number, cap: number) => {
  const result = cash()
  if (fill === 'missingEntry') {
    result.missingEntry++
  } else if (fill !== null) {
    const { side, entry, exit, sizingDistance, reference } = fill
    const qty = Math.floor(Math.min(risk / sizingDistance, cap / reference, cap / (entry * (1 + costs[2] / 20_000))))
    if (qty > 0) {
      result.entryNotional = entry * qty
      if (exit === null) {
        result.unresolved++
      } else {
        const sell = side === 1 ? exit : entry
        result.trades = 1
        result.netBeforeSlippage = qty * (side * (exit - entry) - sell * sellFee)
        result.turnoverAfterFee = qty * (entry + exit - sell * sellFee)
      }
    }
  }
  return result
}

type Change = { readonly remove: Daily; readonly replace?: Daily }
export interface Scenario {
  readonly total: Daily
  readonly omissions: ReadonlyMap<string, Change>
}

const orbScenario = (day: PreparedDay, trial: Orb, allocation: number, loso: boolean): Scenario => {
  const ranked = day.ranked[trial.rangeBars]
    .filter((candidate) => candidate.range.rvol >= trial.rvol && orbFilters(day, trial, candidate))
    .slice(0, trial.top + Number(loso))
  const cap = allocation * Math.min(60_000, grossCap / trial.top)
  const risk = (allocation * 0.01 * equity) / trial.top
  const total = cash()
  const omissions = new Map<string, Change>()
  const last = ranked[trial.top]
  const replace = last === undefined ? undefined : account(orbFill(day, trial, last), risk, cap)
  for (const candidate of ranked.slice(0, trial.top)) {
    const leg = account(orbFill(day, trial, candidate), risk, cap)
    add(total, leg)
    if (loso) omissions.set(candidate.symbol, replace === undefined ? { remove: leg } : { remove: leg, replace })
  }
  return { total, omissions }
}

const noiseScenario = (day: PreparedDay, trial: Noise, allocation: number, loso: boolean): Scenario => {
  const universe = universes[trial.universe]
  const cap = allocation * Math.min(60_000, grossCap / universe.length)
  // One portfolio ATR of movement has a 1.5% equity budget, before truncation by gross/leg caps.
  const risk = (allocation * 0.015 * equity) / universe.length
  const total = cash()
  const omissions = new Map<string, Change>()
  for (const symbol of universe) {
    const leg = account(noiseFill(day, trial, symbol), risk, cap)
    add(total, leg)
    if (loso) omissions.set(symbol, { remove: leg })
  }
  return { total, omissions }
}

export const replay = (days: readonly PreparedDay[], trial: Trial, loso: boolean): readonly Scenario[] =>
  days.map((day) => {
    if (trial.engine === 'orb') return orbScenario(day, trial, 1, loso)
    if (trial.engine === 'noise') return noiseScenario(day, trial, 1, loso)
    const orb = orbScenario(day, trial.orb, trial.orbWeight, loso)
    const noise = noiseScenario(day, trial.noise, 1 - trial.orbWeight, loso)
    add(orb.total, noise.total)
    return { total: orb.total, omissions: new Map([...orb.omissions, ...noise.omissions]) }
  })

export const leaveOut = (scenario: Scenario, symbol: string) => {
  const change = scenario.omissions.get(symbol)
  if (change === undefined) return scenario.total
  const total = { ...scenario.total }
  add(total, change.remove, -1)
  if (change.replace !== undefined) add(total, change.replace)
  return total
}
