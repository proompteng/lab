import { capital, costs } from './clean-factors-grid'
import type { Cost } from './clean-factors-grid'
import type { ReplayDay } from './clean-factors-replay'
import { dailySharpe, deflatedSharpe, mean, sum } from './midday-research-statistics'

export const views = ['zeroCash', 'shyCash', 'shyExcess'] as const
export type View = (typeof views)[number]
export const gateViews = ['zeroCash', 'shyExcess'] as const
export const gateCosts = [10, 20] as const

export function netSeries(days: readonly ReplayDay[], cost: Cost) {
  const initialShy = days[0].previousShyOpen
  const zeroCash = days.map((d) => d.gross - (d.traded * cost) / 20_000 - (d.sold * 0.21) / 10_000 - d.borrow)
  const shyCash = zeroCash.map((net, i) => net + days[i].carry)
  const shyExcess = shyCash.map((net, i) => net - (capital * (days[i].shyOpen - days[i].previousShyOpen)) / initialShy)
  return { zeroCash, shyCash, shyExcess }
}

export const resamples = 10_000
export const bootstrapBlockMean = 5
const plans = new Map<number, { endpoints: Int32Array; draws: Int32Array }>()

function bootstrapPlan(length: number) {
  const existing = plans.get(length)
  if (existing !== undefined) return existing
  let rng = 0x4b19a2f1
  const uniform = () => {
    rng ^= rng << 13
    rng ^= rng >>> 17
    rng ^= rng << 5
    return (rng >>> 0) / 2 ** 32
  }
  const draws = new Int32Array(resamples + 1)
  const endpoints: number[] = []
  const logContinuation = Math.log(1 - 1 / bootstrapBlockMean)
  for (let draw = 0; draw < resamples; draw++) {
    let remaining = length
    while (remaining > 0) {
      const start = Math.floor(uniform() * length)
      const block = Math.min(remaining, 1 + Math.floor(Math.log1p(-uniform()) / logContinuation))
      endpoints.push(start, start + block)
      remaining -= block
    }
    draws[draw + 1] = endpoints.length
  }
  const plan = { endpoints: Int32Array.from(endpoints), draws }
  plans.set(length, plan)
  return plan
}

/** One-sided stationary circular block bootstrap of the mean under the mean-zero null. */
export function stationaryP(values: readonly number[]) {
  if (values.length < 2 * bootstrapBlockMean || dailySharpe(values) === null) return null
  const avg = mean(values)
  const prefix = new Float64Array(2 * values.length + 1)
  for (let i = 0; i < prefix.length - 1; i++) prefix[i + 1] = prefix[i] + values[i % values.length] - avg
  const { endpoints, draws } = bootstrapPlan(values.length)
  const observed = avg * values.length
  let tails = 0
  for (let draw = 0; draw < resamples; draw++) {
    let sampled = 0
    for (let i = draws[draw]; i < draws[draw + 1]; i += 2) {
      sampled += prefix[endpoints[i + 1]] - prefix[endpoints[i]]
    }
    if (sampled >= observed) tails++
  }
  return (1 + tails) / (1 + resamples)
}

export function summarizeSeries(
  values: readonly number[],
  spy: readonly number[],
  infer = false,
  benchmark: number | null = null,
) {
  const net = sum(values)
  const wins = values.filter((net) => net > 0).sort((a, b) => b - a)
  const sharpe = dailySharpe(values)
  let equity = capital,
    peak = capital,
    maxDd = 0,
    maxDdUsd = 0,
    downNet = 0
  let spySse = 0,
    cross = 0
  const xMean = mean(spy),
    yMean = mean(values)
  for (let i = 0; i < values.length; i++) {
    equity += values[i]
    peak = Math.max(peak, equity)
    maxDd = Math.max(maxDd, (peak - equity) / peak)
    maxDdUsd = Math.max(maxDdUsd, peak - equity)
    if (spy[i] < 0) downNet += values[i]
    cross += (spy[i] - xMean) * (values[i] - yMean)
    spySse += (spy[i] - xMean) ** 2
  }
  return {
    netUsd: net,
    exTop5Usd: net - sum(wins.slice(0, 5)),
    exTop10Usd: net - sum(wins.slice(0, 10)),
    annualSharpe: sharpe === null ? null : sharpe * Math.sqrt(252),
    maxDrawdownPct: 100 * maxDd,
    maxDrawdownUsd: maxDdUsd,
    calmar: maxDd > 0 ? (net * 252) / values.length / capital / maxDd : null,
    spyBeta: spySse > 0 ? cross / (spySse * capital) : null,
    downSpyNetUsd: downNet,
    ...(infer ? { stationaryP: stationaryP(values), cumulativeDsr: deflatedSharpe(values, benchmark) } : {}),
  }
}

export type Benchmarks = Record<Cost, Record<View, number | null>>
export type Metric = ReturnType<typeof summarizeSeries>
export type Matrix = Record<Cost, Record<View, Metric>>

export function summarize(days: readonly ReplayDay[], benchmarks?: Benchmarks) {
  const spy = days.map((d) => d.spy)
  const atCost = (cost: Cost) => {
    const series = netSeries(days, cost)
    const atView = (view: View) =>
      summarizeSeries(series[view], spy, benchmarks !== undefined, benchmarks?.[cost][view])
    return { zeroCash: atView('zeroCash'), shyCash: atView('shyCash'), shyExcess: atView('shyExcess') }
  }
  return {
    sessions: days.length,
    turnoverPerYear: ((sum(days.map((d) => d.traded)) / (2 * capital)) * 252) / days.length,
    maxGrossUsd: Math.max(...days.map((d) => d.grossExposure)),
    borrowedUsd: sum(days.map((d) => d.borrow)),
    sellFeesUsd: (sum(days.map((d) => d.sold)) * 0.21) / 10_000,
    idleShyCarryUsd: sum(days.map((d) => d.carry)),
    shyBuyHoldUsd: capital * (days[days.length - 1].shyOpen / days[0].previousShyOpen - 1),
    costs: { 2: atCost(2), 5: atCost(5), 10: atCost(10), 20: atCost(20) },
  }
}

function pearson(a: readonly number[], b: readonly number[]) {
  const aMean = mean(a),
    bMean = mean(b)
  let xy = 0,
    xx = 0,
    yy = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - aMean,
      y = b[i] - bMean
    xy += x * y
    xx += x * x
    yy += y * y
  }
  return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : null
}

export function alignedCorrelations(equity: readonly ReplayDay[], overlay: readonly ReplayDay[]) {
  if (equity.length !== overlay.length || equity.some((d, i) => d.date !== overlay[i].date)) {
    throw new Error('Sleeve correlation requires identical session calendars')
  }
  return costs.map((bp) => {
    const a = netSeries(equity, bp)
    const b = netSeries(overlay, bp)
    return {
      bp,
      zeroCash: pearson(a.zeroCash, b.zeroCash),
      shyCash: pearson(a.shyCash, b.shyCash),
      shyExcess: pearson(a.shyExcess, b.shyExcess),
    }
  })
}
