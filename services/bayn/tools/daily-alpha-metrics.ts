import { type Tape } from './daily-alpha-data'
import { type Bounds, capital, costs, netAt, type Replay, spyDaily } from './daily-alpha-replay'
import { bootstrapPValue, dailySharpe, deflatedSharpe, mean, sum } from './midday-research-statistics'

const annualization = Math.sqrt(252)

export function economics(values: readonly number[]) {
  if (values.length === 0) return null
  const netUsd = sum(values)
  let equity = capital
  let peak = capital
  let drawdown = 0
  for (const value of values) {
    equity += value
    peak = Math.max(peak, equity)
    drawdown = Math.max(drawdown, (peak - equity) / peak)
  }
  const daily = dailySharpe(values)
  const annualReturn = (netUsd / capital) * (252 / values.length)
  return {
    netUsd,
    exTop5Usd: sum(values.toSorted((a, b) => b - a).slice(5)),
    sharpe: daily === null ? null : daily * annualization,
    annualReturn,
    maxDrawdown: drawdown,
    calmar: drawdown > 0 ? annualReturn / drawdown : null,
  }
}

export interface Measured {
  costs: ReturnType<typeof economics>[]
  daily: number[]
  bootstrap: number | null
  active: number
  turnover: number
  roundTripCost10Usd: number
  borrowUsd: number
  sellFeeUsd: number
  peakTradeGross: number
  peakMarkedGross: number
  spyBeta: number | null
  regime: {
    up: { sessions: number; economics: ReturnType<typeof economics> }
    down: { sessions: number; economics: ReturnType<typeof economics> }
  }
}

export function measure(tape: Tape, bounds: Bounds, run: Replay): Measured | null {
  if (run.error !== undefined) return null
  const daily = run.days.map((day) => netAt(day, 10))
  const spy = spyDaily(tape, bounds.start, daily.length)
  const up: number[] = []
  const down: number[] = []
  let centeredSpy = 0
  let cov = 0
  let varSpy = 0
  const classifiedSpy = spy.filter(Number.isFinite)
  if (classifiedSpy.length > 0) centeredSpy = mean(classifiedSpy)
  const center = mean(daily)
  for (let i = 0; i < spy.length; i++) {
    if (!Number.isFinite(spy[i])) continue
    ;(spy[i] >= 0 ? up : down).push(daily[i])
    cov += ((daily[i] - center) / capital) * (spy[i] - centeredSpy)
    varSpy += (spy[i] - centeredSpy) ** 2
  }
  const traded = sum(run.days.map((day) => day.traded))
  const active = run.days.filter((day) => day.active).length
  return {
    costs: costs.map((cost) => economics(cost === 10 ? daily : run.days.map((day) => netAt(day, cost)))),
    daily,
    bootstrap: active > 0 ? bootstrapPValue(daily) : null,
    active,
    turnover: traded / (2 * capital * daily.length),
    roundTripCost10Usd: (traded * 10) / 20_000,
    borrowUsd: sum(run.days.map((day) => day.borrow)),
    sellFeeUsd: (sum(run.days.map((day) => day.sold)) * 0.21) / 10_000,
    peakTradeGross: run.peakTradeGross,
    peakMarkedGross: run.peakMarkedGross,
    spyBeta: varSpy > 0 ? cov / varSpy : null,
    regime: {
      up: { sessions: up.length, economics: economics(up) },
      down: { sessions: down.length, economics: economics(down) },
    },
  }
}

export const tenBp = (result: Measured | null | undefined) => result?.costs[costs.indexOf(10)] ?? null

export interface Evaluation {
  metrics: Measured | null
  error: string | null
  loso: Record<string, number | null>
}

export function gates(
  evaluation: Evaluation | undefined,
  benchmark: number | null,
  plateau: boolean,
  requireDsr: boolean,
) {
  if (evaluation === undefined || evaluation.metrics === null) return [evaluation?.error ?? 'not evaluated']
  const { metrics, loso } = evaluation
  const cost = tenBp(metrics)
  const dsr = deflatedSharpe(metrics.daily, benchmark)
  const failures: string[] = []
  if (!(cost !== null && cost.netUsd > 0)) failures.push('net')
  if (!(cost !== null && cost.exTop5Usd > 0)) failures.push('ex-top-five')
  if (!(cost?.sharpe !== null && cost?.sharpe !== undefined && cost.sharpe >= 1)) failures.push('sharpe')
  if (!(metrics.bootstrap !== null && metrics.bootstrap < 0.05)) failures.push('bootstrap')
  if (requireDsr && !(dsr !== null && dsr >= 0.95)) failures.push('dsr')
  const exclusions = Object.values(loso)
  if (exclusions.length === 0 || exclusions.some((net) => net === null || net <= 0)) failures.push('loso')
  if (!plateau) failures.push('plateau')
  if (metrics.active < 60) failures.push('exposure')
  if (metrics.turnover > 0.5 + 1e-12) failures.push('turnover')
  if (metrics.peakMarkedGross > 1.8 + 1e-12) failures.push('realized gross')
  return failures
}

export function plateauFor(center: Evaluation | undefined, neighbors: readonly { id: string; run?: Evaluation }[]) {
  const sharpe = tenBp(center?.metrics)?.sharpe
  const probes = neighbors.map(({ id, run }) => {
    const metrics = tenBp(run?.metrics)
    const pass =
      metrics !== null &&
      sharpe !== undefined &&
      sharpe !== null &&
      metrics.sharpe !== null &&
      metrics.sharpe >= sharpe * 0.5 &&
      metrics.netUsd > 0 &&
      metrics.exTop5Usd > 0
    return { id, available: metrics !== null, pass }
  })
  const available = probes.filter((probe) => probe.available)
  return {
    pass: available.length >= 2 && probes.filter((probe) => probe.pass).length * 3 >= available.length * 2,
    probes,
  }
}
