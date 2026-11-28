import { elapsedDays } from '../research-lib/calendar'
import {
  calmar,
  exTopExcess,
  maxDrawdown,
  mean,
  sharpe,
  sortino,
  stationaryMeanP,
  type StationaryPlan,
  sum,
  wealth,
} from '../research-lib/statistics'
import { initialUsd, type LedgerRow } from './macro-etf-core-dual-horizon-account'

const annual = 252
export const bootstrap = { draws: 10_000, meanBlock: 10, seed: 0x5c2016 } as const

const correlation = (x: readonly number[], y: readonly number[]) => {
  if (x.length < 2 || x.every((r) => r === x[0]) || y.every((r) => r === y[0])) return null
  const mx = mean(x)
  const my = mean(y)
  const denom = Math.sqrt(sum(x.map((r) => (r - mx) ** 2)) * sum(y.map((r) => (r - my) ** 2)))
  return denom === 0 ? null : sum(x.map((r, i) => (r - mx) * (y[i] - my))) / denom
}

export const drawdownDays = (spy: readonly number[]) => {
  let value = 1
  let peak = 1
  return spy.map((r) => {
    value *= 1 + r
    peak = Math.max(value, peak)
    return value < peak
  })
}

export const pairedCorrelation = (
  overnight: readonly number[],
  intraday: readonly number[],
  drawdown: readonly boolean[],
) => ({
  all: correlation(overnight, intraday),
  spyDrawdownDays: correlation(
    overnight.filter((_, i) => drawdown[i]),
    intraday.filter((_, i) => drawdown[i]),
  ),
  spyDrawdownSessions: drawdown.filter(Boolean).length,
})

export type Day = Pick<
  LedgerRow,
  'date' | 'net' | 'overnight' | 'intraday' | 'oneWayTurnover' | 'overnightOneWayTurnover'
>

export const summarize = (
  rows: readonly Day[],
  shy: readonly number[],
  drawdown: readonly boolean[],
  plan: StationaryPlan,
) => {
  const net = rows.map((r) => r.net)
  const years = (elapsedDays(rows[0].date, rows[rows.length - 1].date) + 1) / 365.2425
  const nav = wealth(net, true)
  const shyWealth = wealth(shy, true)
  const cagr = nav ** (1 / years) - 1
  const shyCagr = shyWealth ** (1 / years) - 1
  const maximumDrawdown = maxDrawdown(net, true)
  const [exTop10] = exTopExcess(net, shy, true, [10])
  const calendarReturns = Object.fromEntries(
    [...new Set(rows.map(({ date }) => date.slice(0, 4)))].map((year) => [
      year,
      wealth(
        rows.filter(({ date }) => date.startsWith(year)).map(({ net }) => net),
        true,
      ) - 1,
    ]),
  )
  return {
    sessions: rows.length,
    from: rows[0].date,
    through: rows[rows.length - 1].date,
    finalEquityUsd: initialUsd * nav,
    totalReturn: nav - 1,
    cagr,
    excessCagrOverShy: cagr - shyCagr,
    excessUsdOverShy: (nav - shyWealth) * initialUsd,
    sharpe: sharpe(net),
    sortino: sortino(net),
    maxDrawdown: maximumDrawdown,
    calmar: calmar(cagr, maximumDrawdown),
    annualOneWayTurnover: mean(rows.map((r) => r.oneWayTurnover)) * annual,
    annualOvernightOneWayTurnover: mean(rows.map((r) => r.overnightOneWayTurnover)) * annual,
    bear2022Return: calendarReturns['2022'] ?? null,
    positiveYears: Object.values(calendarReturns).filter((value) => value > 0).length,
    calendarReturns,
    exTop10DayExcessOverShy: exTop10,
    correlation: pairedCorrelation(
      rows.map((r) => r.overnight),
      rows.map((r) => r.intraday),
      drawdown,
    ),
    stationaryPOverShy: stationaryMeanP(
      net.map((r, i) => r - shy[i]),
      plan,
    ),
  }
}
