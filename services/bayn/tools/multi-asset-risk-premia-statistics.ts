import { annualDays, blockTrials, costs, equity, sellFee } from './multi-asset-risk-premia-protocol'
import { annualTurnover, investedReturn, netReturn } from './multi-asset-risk-premia-replay'
import type { Observation } from './multi-asset-risk-premia-replay'
import { blockBootstrapP, dailySharpe, deflatedSharpe } from './research-orb-zab-statistics'

export { dailySharpe, deflationBenchmark, pearson } from './research-orb-zab-statistics'

const sum = (series: readonly number[]) => series.reduce((total, value) => total + value, 0)

export type Cost = (typeof costs)[number]
export interface Screening {
  readonly net: number
  readonly exTop5Net: number | null
}

export const screen = (rows: readonly Observation[], bp: Cost): Screening => {
  const daily = rows.map((row) => netReturn(row, bp))
  return {
    net: sum(daily) * equity,
    exTop5Net: daily.length > 5 ? sum(daily.toSorted((a, b) => b - a).slice(5)) * equity : null,
  }
}

export const summarize = (rows: readonly Observation[], bp: Cost, benchmark: number | null) => {
  const daily = rows.map((row) => netReturn(row, bp))
  const sorted = daily.toSorted((a, b) => b - a)
  const market = rows.map((row) => row.market)
  const m = sum(market) / market.length
  const avg = sum(daily) / daily.length
  const variance = sum(market.map((x) => (x - m) ** 2))
  const beta = variance > 0 ? sum(market.map((x, i) => (x - m) * (daily[i] - avg))) / variance : null
  let cumulative = 0
  let peak = 0
  let maxDrawdown = 0
  for (const ret of daily) {
    cumulative += ret
    peak = Math.max(peak, cumulative)
    const peakCapital = 1 + peak
    maxDrawdown = Math.max(maxDrawdown, (peak - cumulative) / peakCapital)
  }
  const sharpe = dailySharpe(daily)
  return {
    sessions: rows.length,
    net: cumulative * equity,
    excessReturn: cumulative,
    investedIdleShyTotalReturn: sum(rows.map((row) => investedReturn(row, bp))),
    intentionalShyGrossPnl: sum(rows.map((row) => row.shySecurityPnl)) * equity,
    exTop5Net: sorted.length > 5 ? sum(sorted.slice(5)) * equity : null,
    exTop10Net: sorted.length > 10 ? sum(sorted.slice(10)) * equity : null,
    sharpe: sharpe === null ? null : sharpe * Math.sqrt(annualDays),
    maxDrawdown,
    calmar: maxDrawdown > 0 ? (avg * annualDays) / maxDrawdown : null,
    spyBeta: beta,
    annualizedAlphaVsSpy: beta === null ? null : (avg - beta * m) * annualDays,
    blockP: blockBootstrapP(daily, blockTrials),
    deflatedSharpe: deflatedSharpe(daily, benchmark),
    annualOneWayTurnover: annualTurnover(rows),
    averageGross: sum(rows.map((row) => row.gross)) / rows.length,
    maxGross: Math.max(...rows.map((row) => row.gross)),
    capTrimOpens: rows.filter((row) => row.capTrim).length,
    openTradeSessions: rows.filter((row) => row.slippageNotional > 0).length,
    slippageUsd: (sum(rows.map((row) => row.slippageNotional)) * bp * equity) / 20_000,
    sellFeeUsd: sum(rows.map((row) => row.sellNotional)) * sellFee * equity,
    borrowUsd: sum(rows.map((row) => row.shortCarry)) * equity,
  }
}
