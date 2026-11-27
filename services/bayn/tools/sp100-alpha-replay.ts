import { bootstrapPValue, dailySharpe, deflatedSharpe, mean, sum } from './midday-research-statistics'
import { type Tape } from './sp100-alpha-data'
import { capital, costs, grossCap, targetGross } from './sp100-alpha-protocol'
import { type Targets } from './sp100-alpha-signals'

export type Daily = {
  date: string
  pnl: number
  borrow: number
  sellFee: number
  traded: number
  spy: number | null
  gross: number
}

export function replay(tape: Tape, targets: Targets, [from, through]: readonly [string, string]) {
  const start = tape.dates.indexOf(from)
  const end = tape.dates.indexOf(through)
  if (start < 0 || end <= start || targets.length !== tape.dates.length) throw new Error('Missing replay boundary')
  const shares = new Float64Array(tape.series.length)
  const days: Daily[] = []
  let errors = 0
  let firstError: string | null = null
  for (let i = start; i <= end; i++) {
    const date = tape.dates[i]
    const nights = i === start ? 0 : (Date.parse(date) - Date.parse(tape.dates[i - 1])) / 86_400_000
    let pnl = 0
    let borrow = 0
    let sold = 0
    let traded = 0
    let beforeGross = 0
    let afterGross = 0
    let closeGross = 0
    const fail = (message: string) => {
      errors++
      firstError ??= `${date} ${message}`
    }
    for (let j = 0; j < shares.length; j++) {
      const { symbol, open, close } = tape.series[j]
      const requested = i > 0 && i < end ? targets[i - 1][j] * targetGross : 0
      const held = shares[j]
      if (held === 0 && requested === 0) continue
      if (!(open[i] > 0) || (requested !== 0 && !(close[i - 1] > 0))) {
        fail(`${symbol}: missing execution price or prior close`)
        continue
      }
      if (held !== 0) {
        const ratio = open[i] / open[i - 1]
        if (!(ratio >= 0.5 && ratio <= 2 && close[i - 1] > 0)) fail(`${symbol}: unresolved open mark discontinuity`)
        pnl += held * (open[i] - open[i - 1])
        beforeGross += Math.abs(held * open[i])
        if (held < 0) borrow += (-held * close[i - 1] * 0.015 * nights) / 365
      }
      // Order quantity is determined at the previous close. Opening prices are fills, not sizing inputs.
      const next = requested === 0 ? 0 : requested / close[i - 1]
      const order = (next - held) * open[i]
      afterGross += Math.abs(next * open[i])
      if (next !== 0) {
        if (!(close[i] > 0)) fail(`${symbol}: missing holding Close mark`)
        closeGross += Math.abs(next * close[i])
      }
      traded += Math.abs(order)
      sold += Math.max(0, -order)
      shares[j] = next
    }
    const gross = Math.max(beforeGross, afterGross, closeGross)
    if (gross > grossCap + 1e-8) fail('marked gross exceeds $180,000')
    const spyOpen = tape.series[tape.spy].open
    days.push({
      date,
      pnl,
      borrow,
      sellFee: (sold * 0.21) / 10_000,
      traded,
      gross,
      spy: i === start ? null : spyOpen[i] / spyOpen[i - 1] - 1,
    })
  }
  return { days, errors, firstError }
}

export const net = (day: Daily, bps: number) => day.pnl - day.borrow - day.sellFee - (day.traded * bps) / 20_000

export function economics(days: readonly Daily[], bps: number, benchmark: number | null, bootstrap: boolean) {
  const daily = days.map((day) => net(day, bps))
  const center = mean(daily)
  const ranked = daily.filter((value) => value > 0).sort((a, b) => b - a)
  const netUsd = sum(daily)
  let peak = capital
  let equity = capital
  let maxDrawdown = 0
  for (const value of daily) {
    equity += value
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
  }
  const annualReturn = (netUsd / capital) * (252 / daily.length)
  const sharpe = dailySharpe(daily)
  const paired = days.flatMap(({ spy }, i) => (spy === null ? [] : [{ spy, net: daily[i] }]))
  const spyMean = mean(paired.map(({ spy }) => spy))
  const spyVariance = sum(paired.map(({ spy }) => (spy - spyMean) ** 2))
  const covariance = sum(paired.map(({ spy, net: value }) => (spy - spyMean) * (value - center))) / capital
  const up = paired.filter(({ spy }) => spy >= 0)
  const down = paired.filter(({ spy }) => spy < 0)
  const regime = (rows: typeof paired) => ({ sessions: rows.length, netUsd: sum(rows.map((row) => row.net)) })
  return {
    netUsd,
    exTop5Usd: netUsd - sum(ranked.slice(0, 5)),
    exTop10Usd: netUsd - sum(ranked.slice(0, 10)),
    sharpe: sharpe === null ? null : sharpe * Math.sqrt(252),
    maxDrawdown,
    calmar: maxDrawdown > 0 ? annualReturn / maxDrawdown : null,
    spyBeta: spyVariance > 0 ? covariance / spyVariance : null,
    upSpy: regime(up),
    downSpy: regime(down),
    bootstrapPValue: bootstrap && sharpe !== null ? bootstrapPValue(daily) : null,
    deflatedSharpe: deflatedSharpe(daily, benchmark),
  }
}

export type Run = ReturnType<typeof replay>
export function summarize(run: Run, benchmarks: Record<number, number | null>, bootstrap = true) {
  const { days, errors, firstError } = run
  return {
    sessions: days.length,
    errors,
    firstError,
    activeSessions: days.filter(({ gross }) => gross > 0).length,
    peakGross: days.reduce((max, day) => Math.max(max, day.gross), 0),
    meanDailyTurnover: sum(days.map((day) => day.traded)) / (2 * capital * days.length),
    borrowUsd: sum(days.map((day) => day.borrow)),
    sellFeeUsd: sum(days.map((day) => day.sellFee)),
    costs: {
      5: errors > 0 ? null : economics(days, 5, benchmarks[5], bootstrap),
      10: errors > 0 ? null : economics(days, 10, benchmarks[10], bootstrap),
      20: errors > 0 ? null : economics(days, 20, benchmarks[20], bootstrap),
    },
  }
}

export function annualRuns(run: Run, years: number[], benchmarks: Record<number, number | null>) {
  return Object.fromEntries(
    years.map((year) => [
      year,
      summarize({ ...run, days: run.days.filter(({ date }) => date.startsWith(String(year))) }, benchmarks),
    ]),
  )
}

export function trainBenchmark(runs: Run[]) {
  const calculate = (bps: number) =>
    runs.map(({ days, errors }) => (errors > 0 ? 0 : (dailySharpe(days.map((day) => net(day, bps))) ?? 0)))
  return costs.map((bps) => calculate(bps))
}
