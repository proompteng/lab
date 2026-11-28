import { seriesFor, type Tape, type Universe, universes, wdcExit, wdcReset } from './daily-alpha-data'

export const equityCohorts = ['expanded', 'live', 'expanded-stocks', 'live-stocks'] as const
const etfCohorts = ['etfs', 'live-etfs'] as const
export const ensembleWindows = [15, 20, 30] as const

type Family = 'overnight' | 'momentum' | 'reversal' | 'etf-trend' | 'etf-rotation'
type Execution = 'close-open' | 'lagged-close-open' | 'close-close' | 'open-open' | 'open-close' | 'gap-open-close'
export type Phase = 'open' | 'close'
export interface Trial {
  family: Family
  execution: Execution
  universe: Universe
  lookback: number
  fit: number
  k: number
  hold: number
  skip: number
  volumeVeto: boolean
}

export const trialId = (trial: Trial) =>
  [
    trial.family,
    trial.execution,
    trial.universe,
    trial.lookback,
    trial.fit,
    trial.k,
    trial.hold,
    trial.skip,
    Number(trial.volumeVeto),
  ].join('/')
export const familyGroup = (family: Family) => (family.startsWith('etf-') ? 'etf' : family)
export const isSubmittable = (trial: Trial) =>
  trial.execution !== 'close-close' && trial.execution !== 'close-open' && trial.execution !== 'gap-open-close'
export const liquidateAt = (trial: Trial): Phase =>
  trial.execution === 'close-close' || trial.execution === 'open-close' || trial.execution === 'gap-open-close'
    ? 'close'
    : 'open'

export function trialGrid() {
  const trials: Trial[] = []
  for (const universe of equityCohorts) {
    for (const execution of ['close-open', 'lagged-close-open'] as const)
      for (const lookback of [3, 5, 10])
        for (const fit of [40, 60])
          for (const k of [3, 5, 8])
            trials.push({
              family: 'overnight',
              universe,
              execution,
              lookback,
              fit,
              k,
              hold: 1,
              skip: 0,
              volumeVeto: false,
            })
    for (const execution of ['close-close', 'open-open'] as const)
      for (const lookback of [5, 10, 20, 60])
        for (const skip of [0, 1])
          for (const k of [4, 6, 8])
            for (const hold of [3, 5, 10])
              trials.push({
                family: 'momentum',
                universe,
                execution,
                lookback,
                fit: 60,
                k,
                hold,
                skip,
                volumeVeto: false,
              })
    for (const execution of ['close-close', 'open-close', 'gap-open-close'] as const)
      for (const lookback of [1, 2])
        for (const volumeVeto of [false, true])
          for (const hold of execution === 'close-close' ? [1, 2, 3] : [1])
            trials.push({ family: 'reversal', universe, execution, lookback, fit: 40, k: 5, hold, skip: 0, volumeVeto })
  }
  for (const universe of etfCohorts)
    for (const family of ['etf-trend', 'etf-rotation'] as const)
      for (const execution of ['close-close', 'open-open'] as const)
        for (const lookback of [10, 20, 60])
          trials.push({
            family,
            universe,
            execution,
            lookback,
            fit: 20,
            k: family === 'etf-rotation' ? 3 : 0,
            hold: 5,
            skip: 0,
            volumeVeto: false,
          })
  return trials
}

const dimensions = ['lookback', 'fit', 'k', 'hold', 'skip', 'volumeVeto'] as const
export function neighbors(trial: Trial, grid: readonly Trial[]) {
  return dimensions.flatMap((dimension) => {
    const peers = grid.filter(
      (other) =>
        other.universe === trial.universe &&
        other.family === trial.family &&
        other.execution === trial.execution &&
        dimensions.every((key) => key === dimension || other[key] === trial[key]),
    )
    const ordered = peers.toSorted((a, b) => Number(a[dimension]) - Number(b[dimension]))
    const i = ordered.findIndex((other) => other[dimension] === trial[dimension])
    return [ordered[i - 1], ordered[i + 1]].filter((other) => other !== undefined)
  })
}

interface Scored {
  symbol: string
  score: number
  volatility: number
}
export type Plan = ReadonlyMap<string, number>
export type Planner = (index: number, phase: Phase, omit?: string) => Plan | undefined
export const flat: Plan = new Map()
const annualizer = Math.sqrt(252)

function moment(values: Float64Array, end: number, length: number) {
  if (end + 1 < length) return undefined
  let total = 0
  let squared = 0
  for (let i = end - length + 1; i <= end; i++) {
    const value = values[i]
    if (!Number.isFinite(value)) return undefined
    total += value
    squared += value * value
  }
  return { total, squared }
}

export function residualScore(values: Float64Array, market: Float64Array, end: number, fit: number, lookback: number) {
  const stock = moment(values, end, fit)
  const spy = moment(market, end, fit)
  if (stock === undefined || spy === undefined) return undefined
  const variance = spy.squared - spy.total ** 2 / fit
  if (variance < 1e-12) return undefined
  let products = 0
  let tail = 0
  let marketTail = 0
  for (let i = end - fit + 1; i <= end; i++) {
    products += values[i] * market[i]
    if (i > end - lookback) {
      tail += values[i]
      marketTail += market[i]
    }
  }
  const covariance = products - (stock.total * spy.total) / fit
  const beta = covariance / variance
  const volatility = Math.sqrt((stock.squared - stock.total ** 2 / fit - beta * covariance) / (fit - 1))
  return volatility > 1e-6 ? { score: (tail - beta * marketTail) / volatility, volatility } : undefined
}

function etfScore(values: Float64Array, end: number, lookback: number) {
  const recent = moment(values, end, lookback)
  const risk = moment(values, end, 20)
  if (recent === undefined || risk === undefined) return undefined
  const volatility = Math.sqrt((risk.squared - risk.total ** 2 / 20) / 19)
  return volatility > 1e-6 ? { score: recent.total / volatility, volatility } : undefined
}

function passesVolumeVeto(tape: Tape, symbol: string, end: number) {
  const { bars } = seriesFor(tape, symbol)
  const current = bars[end]
  if (
    current === undefined ||
    end < 20 ||
    (symbol === 'WDC' && tape.dates[end] >= wdcReset && tape.dates[end - 20] < wdcReset)
  )
    return false
  let volume = 0
  for (let i = end - 20; i < end; i++) {
    const bar = bars[i]
    if (bar === undefined) return false
    volume += bar.volume
  }
  return current.volume <= (2.5 * volume) / 20
}

function riskScale(tape: Tape, weights: Plan, end: number) {
  const inputs = [...weights].map(([symbol, weight]) => ({ values: seriesFor(tape, symbol).daily, weight }))
  if (end < 19) return 0
  let total = 0
  let squared = 0
  for (let i = end - 19; i <= end; i++) {
    let basket = 0
    for (const { values, weight } of inputs) basket += weight * Math.expm1(values[i])
    if (!Number.isFinite(basket)) return 0
    total += basket
    squared += basket * basket
  }
  const volatility = annualizer * Math.sqrt(Math.max(0, (squared - total ** 2 / 20) / 19))
  return volatility > 0 ? Math.min(1.5, 0.1 / volatility) : 0
}

function basket(tape: Tape, trial: Trial, possible: readonly Scored[], end: number): Plan {
  const weights = new Map<string, number>()
  if (trial.family === 'etf-trend') {
    const active = possible.filter(({ score }) => score !== 0)
    const total = active.reduce((sum, { volatility }) => sum + 1 / volatility, 0)
    for (const { symbol, score, volatility } of active) weights.set(symbol, Math.sign(score) / (volatility * total))
  } else {
    const gap = trial.execution === 'open-close' || trial.execution === 'gap-open-close'
    const longs = (gap ? possible.filter(({ score }) => score > 0) : possible).slice(0, trial.k)
    const shorts = (gap ? possible.filter(({ score }) => score < 0) : possible).slice(-trial.k)
    if (longs.length !== trial.k || shorts.length !== trial.k || new Set([...longs, ...shorts]).size !== trial.k * 2)
      return flat
    for (const [side, sign] of [
      [longs, 1],
      [shorts, -1],
    ] as const) {
      if (trial.family === 'overnight') {
        const inverse = side.reduce((sum, { volatility }) => sum + 1 / volatility, 0)
        for (const { symbol, volatility } of side) weights.set(symbol, (sign * 0.25) / (volatility * inverse))
      } else {
        for (const { symbol } of side) weights.set(symbol, (sign * 0.5) / trial.k)
      }
    }
  }
  const scale = trial.family === 'momentum' || trial.family.startsWith('etf-') ? riskScale(tape, weights, end) : 1
  if (scale === 0) return flat
  // end is the last available signal Close, including for pre-submitted auction orders.
  for (const [symbol, weight] of weights) {
    const reference = seriesFor(tape, symbol).bars[end]
    if (reference === undefined) throw new Error(`Missing sizing reference for ${symbol}`)
    weights.set(symbol, (weight * scale) / reference.close)
  }
  return weights
}

export function signalPlanners(tape: Tape) {
  const frames = new Map<string, Scored[]>()
  const spy = seriesFor(tape, 'SPY')
  function ranking(trial: Trial, end: number, entry: number) {
    const key = [
      trial.family,
      trial.execution,
      trial.universe,
      trial.lookback,
      trial.fit,
      trial.skip,
      trial.volumeVeto,
      end,
    ].join('/')
    const cached = frames.get(key)
    if (cached !== undefined) return cached
    const ranked: Scored[] = []
    const gapIndex = trial.execution === 'open-close' ? end : trial.execution === 'gap-open-close' ? entry : undefined
    for (const symbol of universes[trial.universe]) {
      if (symbol === 'WDC' && tape.dates[entry] >= wdcExit && tape.dates[end] < wdcReset) continue
      const series = seriesFor(tape, symbol)
      if (series.bars[end] === undefined || (trial.volumeVeto && !passesVolumeVeto(tape, symbol, end))) continue
      const feature =
        trial.family === 'overnight'
          ? residualScore(series.overnight, spy.overnight, end, trial.fit, trial.lookback)
          : trial.family === 'momentum' || trial.family === 'reversal'
            ? residualScore(series.daily, spy.daily, end - trial.skip, trial.fit, trial.lookback)
            : etfScore(series.daily, end, trial.lookback)
      if (feature === undefined) continue
      if (gapIndex !== undefined && !(feature.score * series.overnight[gapIndex] > 0)) continue
      ranked.push({ ...feature, score: trial.family === 'reversal' ? -feature.score : feature.score, symbol })
    }
    ranked.sort((a, b) => b.score - a.score || (a.symbol < b.symbol ? -1 : 1))
    frames.set(key, ranked)
    return ranked
  }
  return (trial: Trial): Planner => {
    const baseline = new Map<number, Plan>()
    const overnight = trial.execution === 'close-open' || trial.execution === 'lagged-close-open'
    const intraday = trial.execution === 'open-close' || trial.execution === 'gap-open-close'
    const sameClose = trial.execution === 'close-close' || trial.execution === 'close-open'
    const entry = overnight || trial.execution === 'close-close' ? 'close' : 'open'
    return (index, phase, omit) => {
      if ((overnight && phase === 'open') || (intraday && phase === 'close')) return flat
      if (phase !== entry || index % trial.hold !== 0) return undefined
      const end = sameClose ? index : index - 1
      if (end < trial.fit + trial.skip) return flat
      const ranked = ranking(trial, end, index)
      let plan = baseline.get(index)
      if (plan === undefined) {
        plan = basket(tape, trial, ranked, end)
        baseline.set(index, plan)
      }
      return omit !== undefined && plan.has(omit)
        ? basket(
            tape,
            trial,
            ranked.filter(({ symbol }) => symbol !== omit),
            end,
          )
        : plan
    }
  }
}
