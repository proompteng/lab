import { stationaryP } from '../vol-regime-carry-metrics'
import { elapsedDays } from '../pure-etf-dual-horizon-data'
import { initialUsd, type LedgerRow } from './macro-etf-core-dual-horizon-account'

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0)
const mean = (values: readonly number[]) => sum(values) / values.length
const compound = (returns: readonly number[]) => returns.reduce((nav, r) => nav * (1 + r), 1)
const annual = 252

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

export const summarize = (rows: readonly Day[], shy: readonly number[], drawdown: readonly boolean[]) => {
  const net = rows.map((r) => r.net)
  const years = (elapsedDays(rows[0].date, rows[rows.length - 1].date) + 1) / 365.2425
  const wealth = compound(net)
  const shyWealth = compound(shy)
  const cagr = wealth ** (1 / years) - 1
  const shyCagr = shyWealth ** (1 / years) - 1
  const average = mean(net)
  const stddev = Math.sqrt(sum(net.map((r) => (r - average) ** 2)) / (net.length - 1))
  const downside = Math.sqrt(mean(net.map((r) => Math.min(0, r) ** 2)))
  let peak = 1
  let nav = 1
  let maxDrawdown = 0
  for (const r of net) {
    nav *= 1 + r
    peak = Math.max(nav, peak)
    maxDrawdown = Math.max(maxDrawdown, 1 - nav / peak)
  }
  const exclude = new Set(
    net
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r > 0)
      .sort((a, b) => b.r - a.r || a.i - b.i)
      .slice(0, 10)
      .map(({ i }) => i),
  )
  const calendarReturns = Object.fromEntries(
    [...new Set(rows.map(({ date }) => date.slice(0, 4)))].map((year) => [
      year,
      compound(rows.filter(({ date }) => date.startsWith(year)).map(({ net }) => net)) - 1,
    ]),
  )
  const exTop = compound(net.filter((_, i) => !exclude.has(i))) - compound(shy.filter((_, i) => !exclude.has(i)))
  return {
    sessions: rows.length,
    from: rows[0].date,
    through: rows[rows.length - 1].date,
    finalEquityUsd: initialUsd * wealth,
    totalReturn: wealth - 1,
    cagr,
    excessCagrOverShy: cagr - shyCagr,
    excessUsdOverShy: (wealth - shyWealth) * initialUsd,
    sharpe: stddev > 0 ? (average * Math.sqrt(annual)) / stddev : null,
    sortino: downside > 0 ? (average * Math.sqrt(annual)) / downside : null,
    maxDrawdown,
    calmar: maxDrawdown > 0 ? cagr / maxDrawdown : null,
    annualOneWayTurnover: mean(rows.map((r) => r.oneWayTurnover)) * annual,
    annualOvernightOneWayTurnover: mean(rows.map((r) => r.overnightOneWayTurnover)) * annual,
    bear2022Return: calendarReturns['2022'] ?? null,
    positiveYears: Object.values(calendarReturns).filter((value) => value > 0).length,
    calendarReturns,
    exTop10DayExcessOverShy: exTop,
    correlation: pairedCorrelation(
      rows.map((r) => r.overnight),
      rows.map((r) => r.intraday),
      drawdown,
    ),
    stationaryPOverShy: stationaryP(net.map((r, i) => r - shy[i])),
  }
}
