import { intradayAlphaCandidateSymbols, intradayAlphaEquitySymbols } from '../src/strategy/intraday-alpha/constants'
import { mean } from './midday-research-statistics'
import type { Candle, Day, Tape } from './sleeve4-data'

const indexes = ['SPY', 'QQQ', 'SMH', 'IWM'] as const
const macro = ['IEF', 'VNQ', 'DBC', 'EFA'] as const
const semis = ['AMD', 'AVGO', 'COHR', 'LITE', 'MRVL', 'MU', 'NVDA', 'WDC'] as const
const longStocks = ['AAPL', 'AMZN', 'NVDA'] as const

export type Signal =
  | 'gap-fade'
  | 'gap-follow'
  | 'first-half'
  | 'persistent'
  | 'risk-rotation'
  | 'rates'
  | 'global'
  | 'commodity'
  | 'dispersion-fade'
  | 'dispersion-follow'
  | 'residual'
  | 'volatile-gap'
  | 'volatile-trend'
export type Panel = 'core' | 'live' | 'sip'
export interface Rule {
  readonly id: string
  readonly group: string
  readonly family: 'A' | 'B' | 'C' | 'D' | 'E'
  readonly signal: Signal
  readonly panel: Panel
  readonly symbols: readonly string[]
  /** Entry follows the last completed minute (entry - 1). */
  readonly entry: number
  readonly exit: number
  readonly threshold: number
  readonly length: number
}

const rules: Rule[] = []
const register = (
  panel: Panel,
  family: Rule['family'],
  signal: Signal,
  label: string,
  symbols: readonly string[],
  timings: readonly (readonly [number, number])[],
  thresholds: readonly number[],
  lengths = [0],
) => {
  const group = `${family}.${panel}.${signal}.${label}`
  for (const [entry, exit] of timings)
    for (const threshold of thresholds)
      for (const length of lengths) {
        rules.push({
          id: `${group}.${entry}-${exit}.${threshold}.${length}`,
          group,
          family,
          signal,
          panel,
          symbols,
          entry,
          exit,
          threshold,
          length,
        })
      }
}
for (const signal of ['gap-fade', 'gap-follow'] as const) {
  for (const [label, symbols] of [
    ['stocks', longStocks],
    ['indexes', indexes],
  ] as const) {
    register(
      'core',
      'A',
      signal,
      label,
      symbols,
      [
        [5, 35],
        [5, 45],
        [5, 60],
      ],
      [0.25, 0.5, 0.75],
    )
  }
  register(
    'live',
    'A',
    signal,
    'bayn-20',
    intradayAlphaCandidateSymbols,
    [
      [5, 35],
      [5, 45],
      [5, 60],
    ],
    [0.25, 0.5, 0.75],
  )
}
for (const signal of ['first-half', 'persistent'] as const) {
  register(
    'core',
    'B',
    signal,
    'indexes',
    indexes,
    [
      [240, 385],
      [270, 385],
      [330, 385],
      [360, 385],
    ],
    [0.15, 0.25, 0.35],
  )
  register(
    'live',
    'B',
    signal,
    'macro',
    macro,
    [
      [270, 385],
      [330, 385],
      [360, 385],
    ],
    [0.15, 0.25, 0.35],
  )
}
register(
  'core',
  'C',
  'risk-rotation',
  'indexes',
  ['SMH', 'QQQ', 'IWM', 'SPY'],
  [
    [210, 385],
    [240, 385],
    [270, 385],
  ],
  [15, 30, 45],
)
register(
  'live',
  'C',
  'rates',
  'duration',
  ['QQQ', 'SMH', 'VNQ'],
  [
    [210, 385],
    [270, 385],
  ],
  [10, 20],
)
register(
  'live',
  'C',
  'global',
  'international',
  ['SPY', 'IWM'],
  [
    [210, 385],
    [270, 385],
  ],
  [15, 30],
)
register(
  'live',
  'C',
  'commodity',
  'inflation',
  ['QQQ', 'VNQ'],
  [
    [210, 385],
    [270, 385],
  ],
  [15, 30],
)
for (const signal of ['dispersion-fade', 'dispersion-follow'] as const) {
  register(
    'live',
    'D',
    signal,
    'v2-roster',
    intradayAlphaEquitySymbols,
    [
      [210, 385],
      [240, 385],
      [270, 385],
    ],
    [40, 80],
    [2, 3],
  )
  register(
    'live',
    'D',
    signal,
    'single-names',
    intradayAlphaEquitySymbols.filter((s) => s !== 'IWM'),
    [
      [210, 385],
      [240, 385],
      [270, 385],
    ],
    [40, 80],
    [2, 3],
  )
}
for (const signal of ['residual', 'volatile-gap', 'volatile-trend'] as const) {
  const grid = signal === 'volatile-gap' ? [0.25, 0.5, 0.75] : [0.25, 0.5]
  const lengths = signal === 'volatile-gap' ? [5] : [5, 10]
  register(
    'core',
    'E',
    signal,
    'indexes',
    indexes,
    [
      [5, 380],
      [15, 380],
    ],
    grid,
    lengths,
  )
  register(
    'core',
    'E',
    signal,
    'nvda',
    ['NVDA'],
    [
      [5, 380],
      [15, 380],
    ],
    grid,
    lengths,
  )
  register(
    'live',
    'E',
    signal,
    'semis',
    semis,
    [
      [5, 380],
      [15, 380],
    ],
    grid,
    lengths,
  )
  register('sip', 'E', signal, 'spy', ['SPY'], [[0, 1]], grid, lengths)
  register('sip', 'E', signal, 'indexes', indexes, [[0, 1]], grid, lengths)
  register('sip', 'E', signal, 'semis', semis, [[0, 1]], grid, lengths)
}
export const trialRegistry: readonly Rule[] = rules

export const requiredSymbols = (rule: Rule) => {
  const extra: Partial<Record<Signal, readonly string[]>> = {
    rates: ['IEF'],
    global: ['EFA'],
    commodity: ['DBC'],
    residual: ['SPY'],
    'volatile-trend': ['SPY'],
  }
  const additional = extra[rule.signal] ?? []
  return [...new Set([...rule.symbols, ...additional])]
}

interface Prior {
  readonly previousClose: number
  readonly atr: number
  readonly first5Volume: number | null
  readonly recentTr: number
  readonly momentum5: number
  readonly momentum10: number
}
export interface Frame extends Day {
  readonly prior: ReadonlyMap<string, Prior>
}

const openingVolume = (tape: Tape) => {
  const opening = tape.slice(0, 5)
  return opening.length === 5 && opening.filter(Boolean).length === 5 ? mean(opening.map((b) => b?.volume ?? 0)) : null
}

export const addHistory = <T>(
  days: readonly T[],
  dateOf: (day: T) => string,
  barsOf: (day: T) => ReadonlyMap<string, Candle>,
  volumeOf: (day: T, symbol: string) => number | null,
) => {
  // Exactly 15 earlier sessions are needed for 14 true ranges; sparse IEX days
  // are not silently replaced with older observations.
  return days.map((day, i) => {
    const earlier = days.slice(Math.max(0, i - 15), i)
    const prior = new Map<string, Prior>()
    if (earlier.length !== 15) return { date: dateOf(day), prior }
    const maps = earlier.map(barsOf)
    for (const symbol of maps.at(-1)?.keys() ?? []) {
      const priorBars = maps.flatMap((m) => m.get(symbol) ?? [])
      const last = priorBars.at(-1)
      const lag5 = priorBars.at(-6)
      const lag10 = priorBars.at(-11)
      if (priorBars.length !== 15 || last === undefined || lag5 === undefined || lag10 === undefined) continue
      const ranges = priorBars.slice(1).map(({ high, low }, index) => {
        const previous = priorBars[index]
        if (previous === undefined) throw new Error('Missing prior close for true range')
        return Math.max(high - low, Math.abs(high - previous.close), Math.abs(low - previous.close))
      })
      const volumes = earlier.slice(1).flatMap((v) => volumeOf(v, symbol) ?? [])
      prior.set(symbol, {
        previousClose: last.close,
        atr: mean(ranges),
        recentTr: mean(ranges.slice(-5)),
        first5Volume: volumes.length === 14 ? mean(volumes) : null,
        momentum5: last.close / lag5.close - 1,
        momentum10: last.close / lag10.close - 1,
      })
    }
    return { date: dateOf(day), prior }
  })
}

export const minuteHistory = (days: readonly Day[]): Frame[] => {
  const records = days.map((d) => {
    const bars = new Map<string, Candle>()
    const volumes = new Map<string, number>()
    for (const [sym, tape] of d.tapes) {
      const start = tape[0]
      const end = tape[d.minutes - 1]
      const first5Volume = openingVolume(tape)
      if (first5Volume !== null) volumes.set(sym, first5Volume)
      // Require actual open and close endpoints before using a daily summary;
      // internal IEX gaps are not imputed. Only consumed on later sessions.
      if (start === undefined || end === undefined) continue
      let high = start.high
      let low = start.low
      let volume = 0
      for (const bar of tape)
        if (bar !== undefined) {
          high = Math.max(high, bar.high)
          low = Math.min(low, bar.low)
          volume += bar.volume
        }
      bars.set(sym, { open: start.open, close: end.close, high, low, volume })
    }
    return { date: d.date, bars, volumes }
  })
  const histories = addHistory(
    records,
    (d) => d.date,
    (d) => d.bars,
    (d, symbol) => d.volumes.get(symbol) ?? null,
  )
  return days.map((d, i) => ({ ...d, prior: histories[i]?.prior ?? new Map<string, Prior>() }))
}

export type Leg = { symbol: string; side: number; weight: number }
export type Decision = { observed: boolean; legs: Leg[] }
const unavailable: Decision = { observed: false, legs: [] }

const directions = (symbols: readonly string[], signal: (symbol: string) => number | null): Decision => {
  const legs: Leg[] = []
  let observed = false
  for (const symbol of symbols) {
    const side = signal(symbol)
    if (side === null) continue
    observed = true
    if (side !== 0) legs.push({ symbol, side, weight: 1 / symbols.length })
  }
  return { observed, legs }
}

export const contextSide = (rule: Rule, symbol: string, open: number, priors: Frame['prior']) => {
  const prior = priors.get(symbol)
  if (prior === undefined || prior.atr <= 0) return null
  if (rule.signal === 'volatile-gap') {
    const gap = (open - prior.previousClose) / prior.atr
    return prior.recentTr >= prior.atr && Math.abs(gap) >= rule.threshold ? -Math.sign(gap) : 0
  }
  const spy = priors.get('SPY')
  if (spy === undefined) return null
  const momentum = rule.length === 5 ? 'momentum5' : 'momentum10'
  const residual = prior[momentum] - (symbol === 'SPY' ? 0 : spy[momentum])
  const highVolatility = prior.recentTr >= prior.atr
  if (rule.signal === 'volatile-trend' && !highVolatility) return 0
  return Math.abs(residual) >= (rule.threshold * prior.atr) / prior.previousClose ? Math.sign(residual) : 0
}

export const decide = (rule: Rule, day: Frame): Decision => {
  // Fixed ET clocks: don't enter if the published close precludes the full holding window.
  if (rule.exit >= day.minutes) return { observed: true, legs: [] }
  const previousBar = (symbol: string) => day.tapes.get(symbol)?.[rule.entry - 1]
  const openingReturn = (symbol: string) => {
    const open = day.tapes.get(symbol)?.[0]?.open
    const completed = previousBar(symbol)
    return open !== undefined && completed !== undefined ? 10_000 * (completed.close / open - 1) : null
  }
  if (rule.family === 'C') {
    const leaders: Partial<Record<Signal, string>> = { rates: 'IEF', global: 'EFA', commodity: 'DBC' }
    const leader = leaders[rule.signal]
    if (leader !== undefined) {
      const value = openingReturn(leader)
      if (value === null) return unavailable
      return directions(rule.symbols, (symbol) =>
        previousBar(symbol) === undefined
          ? null
          : Math.abs(value) >= rule.threshold
            ? Math.sign(value) * (rule.signal === 'commodity' ? -1 : 1)
            : 0,
      )
    }
    const [smh, qqq, iwm, spy] = ['SMH', 'QQQ', 'IWM', 'SPY'].map(openingReturn)
    if (smh == null || qqq == null || iwm == null || spy == null) return unavailable
    const score = (smh + qqq - iwm - spy) / 2
    const riskGroup = (s: string) => s === 'SMH' || s === 'QQQ'
    const risk = rule.symbols.filter(riskGroup).length
    const defense = rule.symbols.length - risk
    if (Math.abs(score) < rule.threshold || risk === 0 || defense === 0) return { observed: true, legs: [] }
    return {
      observed: true,
      legs: rule.symbols.map((symbol) => ({
        symbol,
        side: Math.sign(score) * (riskGroup(symbol) ? 1 : -1),
        weight: 0.5 / (riskGroup(symbol) ? risk : defense),
      })),
    }
  }
  if (rule.family === 'D') {
    const ranked = rule.symbols
      .flatMap((symbol) => {
        if (symbol === 'SPY') return []
        const close = previousBar(symbol)?.close
        // Rank returns since 12:30 ET, using only completed bars at both endpoints.
        const base = day.tapes.get(symbol)?.[179]?.close
        return close !== undefined && base !== undefined ? [{ symbol, bps: 10_000 * (close / base - 1) }] : []
      })
      .sort((a, b) => a.bps - b.bps || a.symbol.localeCompare(b.symbol))
    if (ranked.length < Math.max(2 * rule.length, Math.ceil(rule.symbols.length * 0.8))) return unavailable
    const bottom = ranked.slice(0, rule.length)
    const top = ranked.slice(-rule.length)
    if (mean(top.map((r) => r.bps)) - mean(bottom.map((r) => r.bps)) < rule.threshold) {
      return { observed: true, legs: [] }
    }
    const side = rule.signal === 'dispersion-follow' ? 1 : -1
    return {
      observed: true,
      legs: [
        ...bottom.map(({ symbol }) => ({ symbol, side: -side, weight: 0.5 / rule.length })),
        ...top.map(({ symbol }) => ({ symbol, side, weight: 0.5 / rule.length })),
      ],
    }
  }
  return directions(rule.symbols, (symbol) => {
    const tape = day.tapes.get(symbol)
    const open = tape?.[0]?.open
    const completed = previousBar(symbol)
    const prior = day.prior.get(symbol)
    if (tape === undefined || open === undefined || completed === undefined || prior === undefined || prior.atr <= 0)
      return null
    if (rule.family === 'A') {
      const gap = (open - prior.previousClose) / prior.atr
      if (Math.abs(gap) < rule.threshold) return 0
      const side = Math.sign(gap)
      const direction = Math.sign(completed.close - open)
      if (rule.signal === 'gap-fade') return direction !== side ? -side : 0
      const volume = openingVolume(tape)
      if (volume === null || prior.first5Volume === null || prior.first5Volume <= 0) return null
      return direction === side && volume >= 1.25 * prior.first5Volume ? side : 0
    }
    if (rule.family === 'B') {
      const firstHalf = tape[29]
      if (firstHalf === undefined) return null
      const early = (firstHalf.close - open) / prior.atr
      if (Math.abs(early) < rule.threshold) return 0
      if (rule.signal === 'first-half') return Math.sign(early)
      const noonToTwo = tape[Math.min(rule.entry - 1, 269)] // capped at 14:00 ET
      if (noonToTwo === undefined) return null
      return prior.recentTr >= prior.atr && Math.sign(early) === Math.sign(noonToTwo.close - firstHalf.close)
        ? Math.sign(early)
        : 0
    }
    return contextSide(rule, symbol, open, day.prior)
  })
}
