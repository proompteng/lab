import type { ActiveAlphaPhase } from '../src/strategy/intraday-alpha/signals'
import { lastDate, trainEnd, validationEnd } from './sip-bayn21-data'
import { equityUsd, sampleDeviation, type Outcome } from './sip-bayn21-replay'

export const halfYears = ['2024H1', '2024H2', '2025H1', '2025H2', '2026H1', '2026H2'] as const
export type Period = 'all' | 'train' | 'validation' | 'holdout' | (typeof halfYears)[number]
export const periods: readonly Period[] = ['all', 'train', 'validation', 'holdout', ...halfYears]

export const inPeriod = (date: string, period: Period) => {
  if (period === 'all') return date <= lastDate
  if (period === 'train') return date <= trainEnd
  if (period === 'validation') return date > trainEnd && date <= validationEnd
  if (period === 'holdout') return date > validationEnd && date <= lastDate
  return period === `${date.slice(0, 4)}H${date.slice(5, 7) <= '06' ? 1 : 2}`
}

export interface Day {
  readonly date: string
  readonly net: number
  readonly winningUsd: number
  readonly losingUsd: number
  readonly perBpUsd: number
  readonly trades: number
  readonly unresolvedExits: number
  readonly blockedStops: number
  readonly blockedMinutes: number
  readonly missingPositionMinutes: number
  readonly ambiguousBars: number
  readonly middaySelected: number
  readonly middayFilled: number
  readonly missingEntryPrices: number
  readonly benchmarkBlocks: number
  readonly plannerBlocks: number
  readonly capBlocks: number
  readonly maxGrossUsd: number
  readonly bySymbol: Readonly<Record<string, number>>
}

export const aggregateDay = (date: string, outcome: Outcome, phase?: ActiveAlphaPhase): Day => {
  const trades = phase === undefined ? outcome.trades : outcome.trades.filter((trade) => trade.phase === phase)
  let net = 0
  let winningUsd = 0
  let losingUsd = 0
  let perBpUsd = 0
  let unresolvedExits = 0
  let blockedStops = 0
  let blockedMinutes = 0
  let missingPositionMinutes = 0
  let ambiguousBars = 0
  const bySymbol: Record<string, number> = {}
  for (const trade of trades) {
    blockedStops += Number(trade.exit.blockedMinutes > 0)
    blockedMinutes += trade.exit.blockedMinutes
    missingPositionMinutes += trade.exit.missingMinutes
    ambiguousBars += trade.exit.ambiguousBars
    if (trade.net === null) {
      unresolvedExits++
      continue
    }
    net += trade.net
    winningUsd += Math.max(0, trade.net)
    losingUsd -= Math.min(0, trade.net)
    perBpUsd += trade.linearCostPerBps
    bySymbol[trade.symbol] = (bySymbol[trade.symbol] ?? 0) + trade.net
  }
  const includeMidday = phase === undefined || phase === 'MIDDAY_REVERSION'
  return {
    date,
    net,
    winningUsd,
    losingUsd,
    perBpUsd,
    trades: trades.length,
    unresolvedExits,
    blockedStops,
    blockedMinutes,
    missingPositionMinutes,
    ambiguousBars,
    bySymbol,
    middaySelected: includeMidday ? outcome.middaySelected : 0,
    middayFilled: includeMidday ? outcome.middayFilled : 0,
    missingEntryPrices: phase === undefined ? outcome.missingEntryPrices : 0,
    benchmarkBlocks: phase === undefined ? outcome.benchmarkBlocks : 0,
    plannerBlocks: phase === undefined ? outcome.plannerBlocks : 0,
    capBlocks: phase === undefined ? outcome.capBlocks : 0,
    maxGrossUsd: phase === undefined ? outcome.maxGrossUsd : 0,
  }
}

const blockLength = 5
export const trials = 10_000
const bootstrapStarts = new Map<number, Uint16Array>()
const circularStarts = (n: number) => {
  const existing = bootstrapStarts.get(n)
  if (existing !== undefined) return existing
  let seed = 0x21ba7a26
  const starts = new Uint16Array(trials * Math.ceil(n / blockLength))
  for (let i = 0; i < starts.length; i++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    starts[i] = (seed >>> 0) % n
  }
  bootstrapStarts.set(n, starts)
  return starts
}

// One-sided H0: mean <= 0. Subtract the observed mean from resamples; the
// last block is truncated so every trial has the original session count.
export const bootstrapP = (net: readonly number[]) => {
  const n = net.length
  if (n === 0) return null
  const observed = net.reduce((sum, value) => sum + value, 0)
  if (observed === 0 && net.every((value) => value === 0)) return 1
  const starts = circularStarts(n)
  const full = net.map((_, start) => {
    let pnl = 0
    for (let offset = 0; offset < blockLength; offset++) pnl += net[(start + offset) % n]
    return pnl
  })
  const tailSize = n % blockLength
  const tail =
    tailSize === 0
      ? full
      : net.map((_, start) => {
          let pnl = 0
          for (let offset = 0; offset < tailSize; offset++) pnl += net[(start + offset) % n]
          return pnl
        })
  const blocks = Math.ceil(n / blockLength)
  let exceedances = 0
  for (let i = 0; i < starts.length; i += blocks) {
    let sampled = tail[starts[i + blocks - 1]]
    for (let j = 0; j < blocks - 1; j++) sampled += full[starts[i + j]]
    if (sampled - observed >= observed) exceedances++
  }
  return (exceedances + 1) / (trials + 1)
}

export const summarize = (days: readonly Day[], cost: number, withBootstrap = true) => {
  const pnls = days.map(({ net }) => net)
  const sessions = days.length
  const sum = (key: Exclude<keyof Day, 'date' | 'bySymbol'>) => days.reduce((total, day) => total + day[key], 0)
  const closedNetUsd = sum('net')
  const unresolvedExits = sum('unresolvedExits')
  const ordered = pnls.toSorted((a, b) => b - a)
  const mean = sessions === 0 ? 0 : closedNetUsd / sessions
  const sd = sampleDeviation(pnls)
  let equity = 0
  let peak = 0
  let maxDrawdownUsd = 0
  for (const pnl of pnls) {
    equity += pnl
    peak = Math.max(peak, equity)
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity)
  }
  const totalsBySymbol = new Map<string, number>()
  for (const day of days)
    for (const [symbol, net] of Object.entries(day.bySymbol))
      totalsBySymbol.set(symbol, (totalsBySymbol.get(symbol) ?? 0) + net)
  const worstRemoved = [...totalsBySymbol].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0]
  const worstLosso =
    worstRemoved === undefined ? null : { symbol: worstRemoved[0], closedNetUsd: closedNetUsd - worstRemoved[1] }
  const winningUsd = sum('winningUsd')
  const losingUsd = sum('losingUsd')
  const perBpUsd = sum('perBpUsd')
  const middayFourLegOrders = days.filter(({ middaySelected }) => middaySelected === 4).length
  const middayFourLegComplete = days.filter(
    ({ middaySelected, middayFilled }) => middaySelected === 4 && middayFilled === 4,
  ).length
  const middayOrders = days.filter(({ middaySelected }) => middaySelected > 0).length
  const middayComplete = days.filter(
    ({ middaySelected, middayFilled }) => middaySelected > 0 && middayFilled === middaySelected,
  ).length
  return {
    sessions,
    trades: sum('trades'),
    unresolvedExits,
    closedNetUsd,
    netUsd: unresolvedExits === 0 ? closedNetUsd : null,
    // The other financial statistics are conditional on known closed trades too.
    sharpe: sd > 0 ? (mean * Math.sqrt(252)) / sd : null,
    maxDrawdownUsd,
    maxDrawdownPctOfCapital: (maxDrawdownUsd * 100) / equityUsd,
    calmar: maxDrawdownUsd > 0 ? (mean * 252) / maxDrawdownUsd : null,
    profitFactor: losingUsd > 0 ? winningUsd / losingUsd : null,
    breakevenLinearRoundTripBps: perBpUsd > 0 ? cost + closedNetUsd / perBpUsd : null,
    exTop5NetUsd: ordered.slice(5).reduce((a, b) => a + b, 0),
    exTop10NetUsd: ordered.slice(10).reduce((a, b) => a + b, 0),
    worstLossoAttribution: worstLosso,
    bootstrapP: withBootstrap ? bootstrapP(pnls) : null,
    middayFourLegOrders,
    middayFourLegComplete,
    middayFourLegCompletenessPct:
      middayFourLegOrders === 0 ? null : (100 * middayFourLegComplete) / middayFourLegOrders,
    middayOrders,
    middayComplete,
    middayBasketCompletenessPct: middayOrders === 0 ? null : (100 * middayComplete) / middayOrders,
    blockedStops: sum('blockedStops'),
    blockedMinutes: sum('blockedMinutes'),
    missingPositionMinutes: sum('missingPositionMinutes'),
    ambiguousBars: sum('ambiguousBars'),
    missingEntryPrices: sum('missingEntryPrices'),
    benchmarkBlocks: sum('benchmarkBlocks'),
    plannerBlocks: sum('plannerBlocks'),
    capBlocks: sum('capBlocks'),
    maxGrossUsd: Math.max(0, ...days.map(({ maxGrossUsd }) => maxGrossUsd)),
  }
}

export type Metrics = ReturnType<typeof summarize>
