import { dailySharpe, deflatedSharpe } from './research-orb-zab-statistics'
import type { Day } from './vol-regime-carry-replay'
import { annualDays } from './vol-regime-carry-signals'

const sum = (series: readonly number[]) => series.reduce((total, value) => total + value, 0)
export const compound = (series: readonly number[]) => series.reduce((equity, value) => equity * (1 + value), 1) - 1
export const round = (value: number | null) => {
  if (value === null) return null
  if (!Number.isFinite(value)) throw new Error('Non-finite research metric')
  return Number(value.toFixed(9))
}

export const windows = [
  { id: 'Train', start: '2016-01-04', end: '2021-12-31' },
  { id: 'Validation', start: '2022-01-03', end: '2023-12-29' },
  { id: 'Holdout', start: '2024-01-02', end: '2026-11-25' },
  { id: 'Full', start: '2016-01-04', end: '2026-11-25' },
  ...Array.from({ length: 11 }, (_, i) => {
    const year = String(2016 + i)
    return { id: year, start: `${year}-01-01`, end: `${year}-12-31` }
  }),
]
export const windowDays = <T extends { date: string }>(days: readonly T[], { start, end }: (typeof windows)[number]) =>
  days.filter(({ date }) => date >= start && date <= end)

export const metricColumns = [
  'net',
  'excess',
  'exTop5Net',
  'exTop5Excess',
  'exTop10Net',
  'exTop10Excess',
  'sharpe',
  'excessSharpe',
  'maxDrawdown',
  'calmar',
  'oneWayAnnualTurnover',
  'spyBeta',
  'downSpyNet',
  'downSpyExcess',
  'annualExecutionCost',
] as const
type Metric = (typeof metricColumns)[number]

export const summarize = (days: readonly Day[], book: 'idle' | 'zero') => {
  const net = days.map((day) => day[book].net)
  const shy = days.map((day) => day.shy)
  const spy = days.map((day) => day.spy)
  const excess = net.map((ret, i) => ret - shy[i])
  let wealth = 1
  let peak = 1
  let drawdown = 0
  for (const day of net) {
    wealth *= 1 + day
    peak = Math.max(peak, wealth)
    drawdown = Math.max(drawdown, 1 - wealth / peak)
  }
  const top = net
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r > 0)
    .sort((a, b) => b.r - a.r)
  const excluding = (count: number) => {
    const skip = new Set(top.slice(0, count).map(({ i }) => i))
    const strategy = compound(net.filter((_, i) => !skip.has(i)))
    return { strategy, excess: strategy - compound(shy.filter((_, i) => !skip.has(i))) }
  }
  const ex5 = excluding(5)
  const ex10 = excluding(10)
  const down = compound(net.filter((_, i) => spy[i] < 0))
  const spyMean = sum(spy) / spy.length
  const netMean = sum(net) / net.length
  const denominator = sum(spy.map((r) => (r - spyMean) ** 2))
  const annualSharpe = (series: readonly number[]) => {
    const daily = dailySharpe(series)
    return daily === null ? null : daily * Math.sqrt(annualDays)
  }
  return {
    net: wealth - 1,
    excess: wealth - 1 - compound(shy),
    exTop5Net: ex5.strategy,
    exTop5Excess: ex5.excess,
    exTop10Net: ex10.strategy,
    exTop10Excess: ex10.excess,
    sharpe: annualSharpe(net),
    excessSharpe: annualSharpe(excess),
    maxDrawdown: drawdown,
    calmar: drawdown > 0 ? (wealth ** (annualDays / days.length) - 1) / drawdown : null,
    oneWayAnnualTurnover: (annualDays * sum(days.map((day) => day[book].turnover))) / days.length,
    spyBeta: denominator > 0 ? sum(spy.map((r, i) => (r - spyMean) * (net[i] - netMean))) / denominator : null,
    downSpyNet: down,
    downSpyExcess: down - compound(shy.filter((_, i) => spy[i] < 0)),
    annualExecutionCost: (annualDays * sum(days.map((day) => day[book].fees))) / days.length,
  } satisfies Record<Metric, number | null>
}
export type Metrics = ReturnType<typeof summarize>
export const compactMetrics = (metrics: Metrics) => metricColumns.map((column) => round(metrics[column]))
export const structural = (folds: readonly Metrics[]) => folds.every((m) => m.excess > 0 && m.oneWayAnnualTurnover < 4)
export const robust = (folds: readonly Metrics[]) =>
  structural(folds) && folds.every((m) => m.exTop5Excess > 0 && m.exTop10Excess > 0)

export const bootstrap = { draws: 10_000, meanBlock: 10, seed: 0x5c2016 } as const
const schedules = new Map<number, Uint32Array>()

const plan = (n: number) => {
  const cached = schedules.get(n)
  if (cached !== undefined) return cached
  let state: number = bootstrap.seed
  const uniform = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
  const blocks: number[] = []
  for (let draw = 0; draw < bootstrap.draws; draw++) {
    let remaining = n
    while (remaining > 0) {
      const start = Math.floor(uniform() * n)
      const length = Math.min(remaining, 1 + Math.floor(Math.log1p(-uniform()) / Math.log1p(-1 / bootstrap.meanBlock)))
      remaining -= length
      blocks.push(start, start + length)
    }
  }
  const packed = Uint32Array.from(blocks)
  schedules.set(n, packed)
  return packed
}

export const stationaryP = (paired: readonly number[]) => {
  const n = paired.length
  if (n < 2 || paired.every((value) => value === paired[0])) return null
  const observed = sum(paired)
  const mean = observed / n
  const prefix = new Float64Array(2 * n + 1)
  for (let i = 0; i < 2 * n; i++) prefix[i + 1] = prefix[i] + (paired[i % n] - mean)
  const blocks = plan(n)
  let hits = 0
  let cursor = 0
  for (let draw = 0; draw < bootstrap.draws; draw++) {
    let resample = 0
    let remaining = n
    while (remaining > 0) {
      const start = blocks[cursor++]
      const stop = blocks[cursor++]
      resample += prefix[stop] - prefix[start]
      remaining -= stop - start
    }
    if (resample >= observed) hits++
  }
  return (hits + 1) / (bootstrap.draws + 1)
}

export const inference = (days: readonly Day[], benchmark: number | null, widerBenchmark: number | null) => {
  const paired = days.map((day) => day.idle.net - day.shy)
  return {
    stationaryP: stationaryP(paired),
    cumulativeDsr: deflatedSharpe(paired, benchmark),
    widerDsr: deflatedSharpe(paired, widerBenchmark),
  }
}
