import { capital, type Daily, type EquityMode } from './master-portfolio-account'
import { dailySharpe, mean, sum } from './midday-research-statistics'

const annual = 252
const trials = 10_000
const meanBlock = 5

/** Circular stationary bootstrap (geometric blocks). Pair the active return and path draws. */
export function stationaryBootstrap(
  returns: readonly number[],
  active: readonly number[],
  mode: EquityMode,
  draws = trials,
) {
  if (returns.length === 0 || returns.length !== active.length || draws < 1) throw new Error('Invalid bootstrap sample')
  const n = returns.length
  const center = mean(active)
  const observed = sum(active)
  const centered = active.map((value) => value - center)
  const drawdowns = new Float64Array(draws)
  let state = 0x4234594e
  const uniform = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4_294_967_296
  }
  let extreme = 0
  for (let trial = 0; trial < draws; trial++) {
    let idx = Math.floor(uniform() * n)
    let test = 0
    let equity = 1
    let peak = 1
    let maxDrawdown = 0
    for (let i = 0; i < n; i++) {
      test += centered[idx]
      equity += returns[idx] * (mode === 'compounded' ? equity : 1)
      peak = Math.max(peak, equity)
      maxDrawdown = Math.max(maxDrawdown, Math.min(1, 1 - equity / peak))
      if (equity <= 0) equity = mode === 'compounded' ? 0 : equity
      if (uniform() < 1 / meanBlock) idx = Math.floor(uniform() * n)
      else if (++idx === n) idx = 0
    }
    if (test >= observed) extreme++
    drawdowns[trial] = maxDrawdown
  }
  drawdowns.sort()
  const tail = drawdowns.subarray(Math.floor(0.95 * draws))
  return {
    trials: draws,
    meanBlock,
    pValue: (extreme + 1) / (draws + 1),
    maxDrawdownVaR95: tail[0],
    maxDrawdownCVaR95: tail.reduce((total, value) => total + value, 0) / tail.length,
  }
}

const annualSharpe = (value: number | null) => (value === null ? null : value * Math.sqrt(annual))
const growth = (returns: readonly number[]) => returns.reduce((value, ret) => value * (1 + ret), 1)
const cagr = (factor: number, n: number) => factor ** (annual / n) - 1
const amount = (value: number) => Math.round(value * 100) / 100

function maxDrawdown(days: readonly Daily[]) {
  let peak = capital
  let max = 0
  for (const { equity } of days) {
    peak = Math.max(peak, equity)
    max = Math.max(max, (peak - equity) / peak)
  }
  return max
}

function covariance(xs: readonly number[], ys: readonly number[]) {
  if (xs.length !== ys.length) throw new Error('Mismatched return series')
  const x = mean(xs)
  const y = mean(ys)
  return xs.reduce((total, value, i) => total + (value - x) * (ys[i] - y), 0)
}

export function correlation(a: readonly number[], b: readonly number[]) {
  const denom = Math.sqrt(covariance(a, a) * covariance(b, b))
  return denom > 0 ? covariance(a, b) / denom : null
}

const activeVersus = (net: readonly number[], benchmark: readonly number[]) => net.map((ret, i) => ret - benchmark[i])

export function summarize(days: readonly Daily[], mode: EquityMode, inference = true) {
  if (days.length === 0) throw new Error('No account sessions')
  const fixed = mode === 'fixed'
  const n = days.length
  const end = days[n - 1].equity
  const pnl = days.map(({ net }) => net)
  const net = days.map(({ net, startEquity }) => net / (fixed ? capital : startEquity))
  const shy = days.map((day) => day.shy)
  const spy = days.map((day) => day.spy)
  const active = activeVersus(net, shy)
  const variance = covariance(spy, spy)
  const dd = maxDrawdown(days)
  const annualGrowth = cagr(end / capital, n)
  const sortino = (returns: readonly number[]) => {
    const downside = Math.sqrt(mean(returns.map((value) => Math.min(0, value) ** 2)))
    return downside > 0 ? (Math.sqrt(annual) * mean(returns)) / downside : null
  }
  const comparison = (benchmark: readonly number[]) => {
    // Benchmarks are buy-and-hold (SHY/SPY) or continuously rebalanced (60/40); no trading costs.
    const factor = growth(benchmark)
    return {
      benchmarkNetUsd: amount(capital * (factor - 1)),
      benchmarkCagr: cagr(factor, n),
      excessNetUsd: amount(end - capital * factor),
      excessCagr: annualGrowth - cagr(factor, n),
      informationRatio: annualSharpe(dailySharpe(activeVersus(net, benchmark))),
    }
  }
  const yearly = new Map<string, Daily[]>()
  for (const day of days) {
    const year = day.date.slice(0, 4)
    const rows = yearly.get(year) ?? []
    rows.push(day)
    yearly.set(year, rows)
  }
  const down = days.filter((day) => day.spy < 0)
  return {
    sessions: n,
    netUsd: amount(end - capital),
    netBeforeCashCarryUsd: amount(sum(days.map(({ overnightNet, intradayNet }) => overnightNet + intradayNet))),
    cagr: annualGrowth,
    sharpe: annualSharpe(dailySharpe(net)),
    sortino: sortino(net),
    sortinoVsShy: sortino(active),
    maxDrawdown: dd,
    calmar: dd > 0 ? annualGrowth / dd : null,
    exTop5NetUsd: amount(
      sum(pnl) -
        sum(
          pnl
            .filter((value) => value > 0)
            .toSorted((a, b) => b - a)
            .slice(0, 5),
        ),
    ),
    spyBeta: variance > 0 ? covariance(net, spy) / variance : null,
    downSpy: { sessions: down.length, netUsd: amount(sum(down.map(({ net }) => net))) },
    versus: { shy: comparison(shy), sixtyForty: comparison(days.map((day) => day.sixtyForty)), spy: comparison(spy) },
    bootstrap: inference ? stationaryBootstrap(net, active, mode) : null,
    calendarYears: Object.fromEntries(
      [...yearly].map(([year, rows]) => {
        const initial = rows[0].startEquity
        const terminal = rows[rows.length - 1].equity
        const yearShy = growth(rows.map(({ shy }) => shy))
        return [
          year,
          {
            sessions: rows.length,
            netUsd: amount(terminal - initial),
            totalReturn: terminal / initial - 1,
            excessShyUsd: amount(terminal - initial * yearShy),
          },
        ]
      }),
    ),
    exposure: {
      peakOpenOvernightUsd: amount(Math.max(...days.map(({ overnightGross }) => overnightGross))),
      peakCloseOvernightUsd: amount(Math.max(...days.map(({ closeGross }) => closeGross))),
      peakCombinedReservedUsd: amount(Math.max(...days.map(({ peakCombined }) => peakCombined))),
      openingGapAbove150k: days
        .filter(({ gapGross }) => gapGross > 150_000)
        .map(({ date }) => date)
        .join(','),
      overnightTrimDays: days
        .filter(({ overnightTrim }) => overnightTrim)
        .map(({ date }) => date)
        .join(','),
      intradayScaledDays: days
        .filter(({ intraday }) => intraday.scaled)
        .map(({ date }) => date)
        .join(','),
      combinedCapDays: days
        .filter(({ intraday }) => intraday.grossCapHit)
        .map(({ date }) => date)
        .join(','),
      dtbpCapDays: days
        .filter(({ intraday }) => intraday.dtbpHit)
        .map(({ date }) => date)
        .join(','),
      intradayTrades: sum(days.map(({ intraday }) => intraday.trades)),
      missingIntradayEntries: sum(days.map(({ intraday }) => intraday.missing)),
      annualOneWayOvernightTurnover:
        (sum(days.map(({ traded, startEquity }) => traded / (fixed ? capital : startEquity))) * annual) / (2 * n),
      meanIdleCashUsd: amount(mean(days.map(({ idleCash }) => idleCash))),
      cashCarryUsd: amount(sum(days.map(({ carry }) => carry))),
      borrowUsd: amount(sum(days.map(({ borrow }) => borrow))),
      debitUsd: amount(sum(days.map(({ debit }) => debit))),
      overnightSpreadUsd: amount(sum(days.map(({ costs }) => costs))),
      overnightSellFeesUsd: amount(sum(days.map(({ sellFees }) => sellFees))),
    },
  }
}

// Store one lossless cent-resolution row per curve rather than thousands of indented JSON lines.
export const equityCurve = (days: readonly Daily[]) => days.map(({ equity }) => Math.round(equity * 100)).join(',')
