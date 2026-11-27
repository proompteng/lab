// Frozen Wave 3C equations from 1731c7ede; no selection or retuning in Wave 6C.
import { annualDays, etfs, grossCap, indexOf } from './multi-asset-risk-premia-protocol'
import type { Etf, Trial } from './multi-asset-risk-premia-protocol'

export interface Bar {
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
}
export interface Session {
  readonly date: string
  readonly bars: readonly (Bar | undefined)[]
}
export type Weights = readonly number[]
export const flat = () => etfs.map(() => 0)
export const gross = (weights: Weights) => weights.reduce((sum, weight) => sum + Math.abs(weight), 0)
export const cap = (weights: Weights) => {
  const exposure = gross(weights)
  return exposure <= grossCap ? weights : weights.map((weight) => (weight * grossCap) / exposure)
}

const spy = indexOf('SPY')
const tlt = indexOf('TLT')
const hyg = indexOf('HYG')
const trendUniverse = [
  'SPY',
  'QQQ',
  'EFA',
  'EEM',
  'TLT',
  'IEF',
  'HYG',
  'LQD',
  'GLD',
  'SLV',
  'DBC',
  'USO',
  'VNQ',
] as const
const tomUniverse = ['SPY', 'QQQ'] as const
const pullbackUniverse = ['SPY', 'QQQ', 'IWM', 'SMH', 'XLK', 'XLF', 'XLV', 'XLI', 'XLY', 'XLE', 'GLD'] as const
const sectors = ['XLK', 'XLF', 'XLV', 'XLY', 'XLC', 'XLI', 'XLP', 'XLE', 'XLU', 'XLRE', 'XLB', 'SMH', 'QQQ'] as const
const defensive = ['GLD', 'TLT', 'SHY'] as const
const horizons = [20, 60, 120, 200] as const
const smaWindows = [5, 50, 100, 200] as const

const trailing = (values: readonly number[], end: number, count: number) =>
  end + 1 >= count ? values.slice(end + 1 - count, end + 1) : []
const mean = (values: readonly number[]) => values.reduce((sum, x) => sum + x, 0) / values.length

export const sampleVol = (values: readonly number[]) => {
  const center = mean(values)
  return Math.sqrt((values.reduce((sum, x) => sum + (x - center) ** 2, 0) / (values.length - 1)) * annualDays)
}

const beta = (values: readonly number[], market: readonly number[]) => {
  const x = mean(market)
  const y = mean(values)
  let covariance = 0
  let variance = 0
  for (let i = 0; i < values.length; i++) {
    covariance += (market[i] - x) * (values[i] - y)
    variance += (market[i] - x) ** 2
  }
  return variance > 0 ? covariance / variance : NaN
}

export const calendar = (dates: readonly string[]) => {
  const offsets: { fromStart: number; toEnd: number; monthBase: number }[] = []
  for (let start = 0; start < dates.length; ) {
    let end = start
    while (dates[end + 1]?.slice(0, 7) === dates[start].slice(0, 7)) end++
    for (let i = start; i <= end; i++) offsets.push({ fromStart: i - start + 1, toEnd: i - end, monthBase: start - 1 })
    start = end + 1
  }
  return offsets
}

// Wilder smoothing starts after two valid changes and resets across missing history.
export const rsi2 = (changes: readonly number[]): number[] => {
  let count = 0
  let gains = 0
  let losses = 0
  return changes.map((change) => {
    if (!Number.isFinite(change)) {
      count = gains = losses = 0
      return NaN
    }
    const gain = Math.max(0, change)
    const loss = Math.max(0, -change)
    count++
    gains = count < 2 ? gain : (gains + gain) / 2
    losses = count < 2 ? loss : (losses + loss) / 2
    return count < 2 ? NaN : gains + losses === 0 ? 50 : (100 * gains) / (gains + losses)
  })
}

export const makeFeatures = (sessions: readonly Session[], calendarTail: readonly string[]) => {
  const dates = calendar([...sessions.map(({ date }) => date), ...calendarTail])
  const closes = etfs.map((_, symbol) => sessions.map((session) => session.bars[symbol]?.close ?? NaN))
  const returns = closes.map((series) => series.map((close, i) => close / series[i - 1] - 1))
  const rsis = closes.map((series) => rsi2(series.map((close, i) => close - series[i - 1])))
  return sessions.map((session, i) => {
    const clock = dates[i]
    const assets = session.bars.map((bar, symbol) => {
      const close = bar?.close ?? NaN
      const sma = smaWindows.map((n) => mean(trailing(closes[symbol], i, n)))
      const momentum = horizons.map((n) => close / closes[symbol][i - n] - 1)
      const daily = trailing(returns[symbol], i, 20)
      const vol = daily.length === 20 ? sampleVol(daily) : NaN
      const tr = []
      for (let day = i - 13; day <= i; day++) {
        const b = sessions[day]?.bars[symbol]
        const prior = closes[symbol][day - 1]
        tr.push(b === undefined ? NaN : Math.max(b.high - b.low, Math.abs(b.high - prior), Math.abs(b.low - prior)))
      }
      const assetLong = trailing(returns[symbol], i, 60)
      const beta60 = assetLong.length === 60 ? beta(assetLong, trailing(returns[spy], i, 60)) : NaN
      return {
        close,
        sma,
        momentum,
        daily,
        vol,
        rsi: rsis[symbol][i],
        atr: mean(tr),
        change3: close - closes[symbol][i - 3],
        beta60,
        mtd: close / closes[symbol][clock.monthBase] - 1,
      }
    })
    return { ...clock, assets, i }
  })
}
type Features = ReturnType<typeof makeFeatures>[number]

const above = (f: Features, i: number, window: (typeof smaWindows)[number]) =>
  f.assets[i].close > f.assets[i].sma[smaWindows.indexOf(window)]

const volTarget = (weights: Weights, f: Features, target: number) => {
  const paper = Array.from({ length: 20 }, (_, day) =>
    weights.reduce((sum, weight, symbol) => (weight === 0 ? sum : sum + weight * f.assets[symbol].daily[day]), 0),
  )
  const vol = sampleVol(paper)
  return vol > 0 ? cap(weights.map((weight) => (weight * target) / vol)) : flat()
}

const buffered = (previous: Weights, desired: Weights) =>
  cap(
    desired.map((weight, i) =>
      Math.sign(weight) === Math.sign(previous[i]) && Math.abs(weight - previous[i]) < 0.05 ? previous[i] : weight,
    ),
  )

const inverseVol = (
  f: Features,
  symbols: readonly Etf[],
  omitted: Etf | undefined,
  direction: (i: number) => number,
) => {
  const w = flat()
  for (const symbol of symbols) {
    const i = indexOf(symbol)
    if (symbol !== omitted && f.assets[i].vol > 0) w[i] = direction(i) / f.assets[i].vol
  }
  return w
}

export const signalBook = (features: readonly Features[], trial: Trial, omitted?: Etf): Weights[] => {
  let previous: Weights = flat()
  const entries = new Map<number, number>()
  const pullbackWeights = flat()
  return features.map((f) => {
    let next = previous
    switch (trial.kind) {
      case 'trend': {
        if (f.i % 5 !== 0) break
        const w = inverseVol(f, trendUniverse, omitted, (i) => {
          const momentum = f.assets[i].momentum
          const signal =
            trial.horizon === 'vote'
              ? momentum.reduce((sum, value) => sum + Math.sign(value), 0)
              : momentum[horizons.indexOf(trial.horizon)]
          return signal > 0 ? 1 : signal < 0 && trial.direction === 'signed' ? -1 : 0
        })
        next = buffered(previous, volTarget(w, f, trial.vol))
        break
      }
      case 'pension': {
        if (f.toEnd === 0) next = flat()
        if (f.toEnd !== trial.signal || omitted === 'SPY' || omitted === 'TLT') break
        const spread = f.assets[spy].mtd - f.assets[tlt].mtd
        if (!(Math.abs(spread) >= trial.threshold)) break
        const w = flat()
        w[spread > 0 ? tlt : spy] = trial.direction === 'spread' ? 0.5 : 1
        if (trial.direction === 'spread') w[spread > 0 ? spy : tlt] = -0.5
        next = w
        break
      }
      case 'tom': {
        if (f.fromStart === trial.through) next = flat()
        if (f.toEnd !== trial.entry - 1) break
        if (trial.filter === 'sma200' && (omitted === 'SPY' || !above(f, spy, 200))) break
        next = volTarget(
          inverseVol(f, tomUniverse, omitted, () => 1),
          f,
          trial.vol,
        )
        break
      }
      case 'pullback': {
        if (trial.hedge && omitted === 'SPY') break
        const exited = new Set<number>()
        for (const [i, entered] of entries) {
          if (f.i - entered >= 7 || (trial.exit === 'sma5' ? above(f, i, 5) : f.assets[i].rsi > 70)) {
            entries.delete(i)
            exited.add(i)
          }
        }
        const eligible = pullbackUniverse
          .filter((symbol) => {
            const i = indexOf(symbol)
            const a = f.assets[i]
            return (
              symbol !== omitted &&
              !(trial.hedge && symbol === 'SPY') &&
              !entries.has(i) &&
              !exited.has(i) &&
              above(f, i, trial.trend) &&
              a.vol > 0 &&
              (!trial.hedge || Number.isFinite(a.beta60)) &&
              (trial.entry === 'atr' ? a.change3 < -1.5 * a.atr : a.rsi < (trial.entry === 'rsi10' ? 10 : 15))
            )
          })
          .sort((a, b) => f.assets[indexOf(a)].rsi - f.assets[indexOf(b)].rsi || indexOf(a) - indexOf(b))
        const added = eligible.slice(0, 4 - entries.size)
        if (exited.size === 0 && added.length === 0) break
        const w = pullbackWeights
        for (const i of exited) w[i] = 0
        for (const symbol of added) {
          const i = indexOf(symbol)
          entries.set(i, f.i)
          w[i] = Math.min(0.25, 0.05 / f.assets[i].vol)
        }
        if (trial.hedge) {
          w[spy] = 0
          for (const i of entries.keys()) w[spy] -= w[i] * Math.min(2, Math.max(0, f.assets[i].beta60))
          next = volTarget(w, f, 0.1)
        } else {
          next = [...w]
        }
        break
      }
      case 'rotation': {
        if (f.i % 5 !== 0) break
        const gate = trial.filter === 'credit' ? hyg : spy
        const average = f.assets[gate].sma[trial.filter === 'credit' ? 1 : 3]
        const riskOn = etfs[gate] !== omitted && average > 0 && f.assets[gate].close > average
        const riskOff = etfs[gate] !== omitted && average > 0 && !riskOn
        const pool: readonly Etf[] = riskOn
          ? trial.includeIwm
            ? [...sectors, 'IWM']
            : sectors
          : riskOff
            ? defensive
            : []
        const horizon = horizons.indexOf(trial.horizon)
        const ranked = pool
          .filter((symbol) => symbol !== omitted)
          .map(indexOf)
          .filter((i) => f.assets[i].vol > 0 && f.assets[i].momentum[horizon] > 0)
          .sort(
            (a, b) =>
              f.assets[b].momentum[horizon] / f.assets[b].vol - f.assets[a].momentum[horizon] / f.assets[a].vol ||
              a - b,
          )
        const w = flat()
        for (const i of ranked.slice(0, 3)) w[i] = 1 / 3
        next = w
        break
      }
    }
    previous = next
    return next
  })
}
