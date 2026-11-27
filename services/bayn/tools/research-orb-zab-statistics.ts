import { capital } from './research-orb-zab-protocol'
import type { Outcome } from './research-orb-zab-simulation'

const annualDays = 252
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

export const sessionNet = (day: Outcome): number | null =>
  day.unresolved > 0 || day.unavailableBenchmark > 0 || day.missingEntryBars > 0
    ? null
    : sum(day.trades.map((trade) => trade.net))

const moments = (values: readonly number[]) => {
  if (values.length < 2) return null
  const mean = sum(values) / values.length
  let m2 = 0
  let m3 = 0
  let m4 = 0
  for (const value of values) {
    const d = value - mean
    const sq = d * d
    m2 += sq
    m3 += sq * d
    m4 += sq * sq
  }
  const variance = m2 / values.length
  if (variance <= 0) return null
  return {
    dailySharpe: mean / Math.sqrt(m2 / (values.length - 1)),
    skew: m3 / (values.length * variance ** 1.5),
    kurtosis: m4 / (values.length * variance ** 2),
  }
}

export const dailySharpe = (values: readonly number[]) => moments(values)?.dailySharpe ?? null

// Standard normal CDF via the Abramowitz-Stegun polynomial; sub-micro precision is sufficient here.
const cdf = (z: number) => {
  if (z === 0) return 0.5
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const tail =
    (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z >= 0 ? 1 - tail : tail
}

const quantile = (p: number) => {
  let lo = -8
  let hi = 8
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    if (cdf(mid) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export const deflationBenchmark = (trialDailySharpes: readonly number[], trials: number) => {
  if (trialDailySharpes.length < 2 || trials < 2) return null
  const mean = sum(trialDailySharpes) / trialDailySharpes.length
  const std = Math.sqrt(sum(trialDailySharpes.map((x) => (x - mean) ** 2)) / (trialDailySharpes.length - 1))
  const gamma = 0.5772156649015329
  return std * ((1 - gamma) * quantile(1 - 1 / trials) + gamma * quantile(1 - 1 / (trials * Math.E)))
}

export const deflatedSharpe = (values: readonly number[], benchmark: number | null) => {
  const m = moments(values)
  if (m === null || benchmark === null) return null
  const variance = 1 - m.skew * m.dailySharpe + ((m.kurtosis - 1) * m.dailySharpe ** 2) / 4
  return variance > 0 ? cdf(((m.dailySharpe - benchmark) * Math.sqrt(values.length - 1)) / Math.sqrt(variance)) : null
}

export const bootstrap = { replicates: 999, blockDays: 5, seed: 0x2f12cb61 } as const

/** Circular moving blocks from the mean-centered series; null preserves gaps in the original calendar. */
export const blockBootstrapP = (series: readonly (number | null)[]): number | null => {
  if (series.length < 2 * bootstrap.blockDays || series.some((x) => x === null)) return null
  const values = series.filter((x): x is number => x !== null)
  const observed = sum(values)
  const mean = observed / values.length
  const prefix = [0]
  for (const value of [...values, ...values]) prefix.push(prefix[prefix.length - 1] + value - mean)
  const blockSums = values.map((_, i) => prefix[i + bootstrap.blockDays] - prefix[i])
  let state: number = bootstrap.seed
  const nextIndex = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % values.length
  }
  const fullBlocks = Math.floor(values.length / bootstrap.blockDays)
  const remainder = values.length % bootstrap.blockDays
  let tails = 0
  for (let trial = 0; trial < bootstrap.replicates; trial++) {
    let resampled = 0
    for (let block = 0; block < fullBlocks; block++) resampled += blockSums[nextIndex()]
    if (remainder > 0) {
      const start = nextIndex()
      resampled += prefix[start + remainder] - prefix[start]
    }
    if (resampled >= observed) tails++
  }
  return (1 + tails) / (1 + bootstrap.replicates)
}

export const summarize = (days: readonly Outcome[], benchmark: number | null) => {
  const daily = days.map(sessionNet)
  const complete = daily.filter((value): value is number => value !== null)
  const completeNet = sum(complete)
  const net = complete.length === days.length && days.length > 0 ? completeNet : null
  const trades = days.flatMap((day) => day.trades)
  const supportedNet = sum(trades.map((trade) => trade.net))
  const gross = sum(trades.map((trade) => trade.gross))
  const sellFee = sum(trades.map((trade) => trade.feeUsd))
  const friction = sum(trades.map((trade) => trade.friction))
  const notional = sum(trades.map((trade) => trade.notional))
  let cumulative = 0
  let peak = 0
  let maxDrawdownUsd = 0
  for (const value of complete) {
    cumulative += value
    peak = Math.max(cumulative, peak)
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - cumulative)
  }
  const sharpe = dailySharpe(complete)
  const supportedBreakEven = notional > 0 ? ((gross - sellFee) / notional) * 10_000 : null
  const exTop5 = complete.length <= 5 ? null : sum(complete.toSorted((a, b) => b - a).slice(5))
  const completeCaseCalmar =
    maxDrawdownUsd === 0 ? null : (completeNet * annualDays) / (complete.length * maxDrawdownUsd)
  const dsr = deflatedSharpe(complete, benchmark)
  return {
    sessions: days.length,
    completeSessions: complete.length,
    activeSessions: days.filter((day) => day.trades.length > 0).length,
    attempts: sum(days.map((day) => day.attempts)),
    fills: trades.length + sum(days.map((day) => day.unresolved)),
    closed: trades.length,
    collarMisses: sum(days.map((day) => day.collarMisses)),
    missingEntryBars: sum(days.map((day) => day.missingEntryBars)),
    unavailableBenchmark: sum(days.map((day) => day.unavailableBenchmark)),
    unresolved: sum(days.map((day) => day.unresolved)),
    heldGaps: sum(days.map((day) => day.heldGaps)),
    net,
    supportedNet,
    gross,
    sellFee,
    friction,
    notional,
    completeCaseNet: complete.length > 0 ? completeNet : null,
    completeCaseSharpe: sharpe === null ? null : sharpe * Math.sqrt(annualDays),
    completeCaseMaxDrawdownUsd: complete.length === 0 ? null : maxDrawdownUsd,
    completeCaseCalmar,
    completeCaseExTop5Net: exTop5,
    completeCaseDsr: dsr,
    sharpe: net === null || sharpe === null ? null : sharpe * Math.sqrt(annualDays),
    maxDrawdownUsd: net === null ? null : maxDrawdownUsd,
    maxDrawdownPctOfCapital: net === null ? null : (maxDrawdownUsd / capital) * 100,
    calmar: net === null || maxDrawdownUsd === 0 ? null : (net * annualDays) / (days.length * maxDrawdownUsd),
    breakevenBps: net === null ? null : supportedBreakEven,
    supportedBreakEvenBps: supportedBreakEven,
    exTop5Net: net === null ? null : exTop5,
    blockP: blockBootstrapP(daily),
    dsr: net === null ? null : dsr,
  }
}

export const pearson = (a: readonly number[], b: readonly number[]): number | null => {
  if (a.length < 2 || a.length !== b.length) return null
  const meanA = sum(a) / a.length
  const meanB = sum(b) / b.length
  let cross = 0
  let sqA = 0
  let sqB = 0
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    cross += da * db
    sqA += da * da
    sqB += db * db
  }
  return sqA > 0 && sqB > 0 ? cross / Math.sqrt(sqA * sqB) : null
}
