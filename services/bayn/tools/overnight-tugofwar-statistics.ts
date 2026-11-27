import { capital, sellFeeBp } from './overnight-tugofwar-protocol'
import type { Day } from './overnight-tugofwar-replay'
import { dailySharpe, deflatedSharpe } from './research-orb-zab-statistics'

export const annualDays = 252
export const bootstrap = { draws: 10_000, meanBlock: 10, seed: 0x2f12cb61 } as const
export const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
export const net = (day: Day, bp: number) =>
  day.pnl - (day.turnover * (bp / 2) + day.sell * sellFeeBp) / 10_000 - day.borrow
export const annualSharpe = (values: readonly number[]) => {
  const ratio = dailySharpe(values)
  return ratio === null ? null : ratio * Math.sqrt(annualDays)
}

export interface Benchmarks {
  spy: number[]
  shy: number[]
}

export interface Window {
  from: number
  to: number
}

export function series(path: readonly Day[], bench: Benchmarks, { from, to }: Window, bp: number) {
  const rows = path.slice(from, to)
  const pnl = rows.map((day) => net(day, bp))
  const shy = bench.shy.slice(from, to)
  return { rows, pnl, shy, excess: pnl.map((value, i) => value - shy[i]) }
}

export function compact(path: readonly Day[], bench: Benchmarks, window: Window, bp: number) {
  const { pnl, excess } = series(path, bench, window, bp)
  return { netUsd: sum(pnl), excessUsd: sum(excess), sharpe: annualSharpe(pnl) }
}

export function metrics(path: readonly Day[], bench: Benchmarks, window: Window, bp: number) {
  const { rows, pnl, shy, excess } = series(path, bench, window, bp)
  const spy = bench.spy.slice(window.from, window.to)
  const total = sum(pnl)
  const n = pnl.length
  const spyMean = sum(spy) / n
  let spySquares = 0
  let covariance = 0
  let value = 0
  let peak = 0
  let drawdown = 0
  let downSpyNet = 0
  for (const [i, r] of pnl.entries()) {
    value += r
    peak = Math.max(peak, value)
    drawdown = Math.max(drawdown, peak - value)
    const delta = spy[i] - spyMean
    spySquares += delta ** 2
    covariance += (r - total / n) * delta
    if (spy[i] < 0) downSpyNet += r
  }
  const order = pnl.toSorted((a, b) => b - a)
  const dailyTurnover = sum(rows.map((day) => day.turnover)) / (2 * capital * n)
  return {
    days: n,
    activeDays: rows.filter((day) => day.trades > 0).length,
    netUsd: total,
    exTop5Usd: n > 5 ? sum(order.slice(5)) : null,
    exTop10Usd: n > 10 ? sum(order.slice(10)) : null,
    sharpe: annualSharpe(pnl),
    excessSharpe: annualSharpe(excess),
    maxDrawdownUsd: drawdown,
    maxDrawdownPctOfCapital: (100 * drawdown) / capital,
    calmar: drawdown > 0 ? (total * annualDays) / (n * drawdown) : null,
    spyBeta: spySquares > 0 ? covariance / spySquares : null,
    downSpyNetUsd: downSpyNet,
    oneWayDailyTurnover: dailyTurnover,
    oneWayAnnualTurnover: dailyTurnover * annualDays,
    shyNetUsd: sum(shy),
    excessUsd: sum(excess),
    excessReturnPct: (100 * sum(excess)) / capital,
  }
}

/** Fixed nonparametric stationary bootstrap paths, shared across trials in a split. */
export function stationaryPlan(n: number) {
  if (!Number.isInteger(n) || n < 2 * bootstrap.meanBlock || 2 * n > 65_535)
    throw new Error('Unsupported stationary bootstrap window')
  let state: number = bootstrap.seed
  const uniform = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) + 0.5) / 2 ** 32
  }
  const pairs: number[] = []
  const limits: number[] = []
  const q = Math.log1p(-1 / bootstrap.meanBlock)
  for (let draw = 0; draw < bootstrap.draws; draw++) {
    let used = 0
    while (used < n) {
      const start = Math.floor(n * uniform())
      const length = Math.min(n - used, 1 + Math.floor(Math.log(uniform()) / q))
      pairs.push(start, start + length)
      used += length
    }
    limits.push(pairs.length)
  }
  return { n, pairs: Uint16Array.from(pairs), limits }
}

export function stationaryP(values: readonly number[], plan: ReturnType<typeof stationaryPlan>) {
  const { n, pairs, limits } = plan
  if (values.length !== n || n < 2 * bootstrap.meanBlock) throw new Error('Stationary bootstrap window mismatch')
  const observed = sum(values)
  const mean = observed / n
  const prefix = new Float64Array(2 * n + 1)
  for (let i = 0; i < 2 * n; i++) prefix[i + 1] = prefix[i] + (values[i % n] - mean)
  let exceedances = 0
  let i = 0
  for (const limit of limits) {
    let draw = 0
    for (; i < limit; i += 2) draw += prefix[pairs[i + 1]] - prefix[pairs[i]]
    if (draw >= observed) exceedances++
  }
  return (1 + exceedances) / (1 + bootstrap.draws)
}

export function inference(excess: readonly number[], plan: ReturnType<typeof stationaryPlan>, benchmark: number) {
  return { stationaryP: stationaryP(excess, plan), dsr: deflatedSharpe(excess, benchmark) }
}

export function holm(ps: readonly number[]) {
  let running = 0
  const adjusted: number[] = []
  for (const [rank, { p, i }] of ps
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p - b.p)
    .entries()) {
    running = Math.max(running, Math.min(1, p * (ps.length - rank)))
    adjusted[i] = running
  }
  return adjusted
}

/** Equal-risk-contribution on long-only weights by cyclic minimization of 1/2 w'Σw - sum(log(w)). */
export function riskParity(samples: readonly (readonly number[])[]) {
  const covariance = samples.map((a) =>
    samples.map((b) => {
      const ma = sum(a) / a.length
      const mb = sum(b) / b.length
      return sum(a.map((v, i) => (v - ma) * (b[i] - mb))) / (a.length - 1)
    }),
  )
  const ridge = Math.max(...covariance.map((row, i) => row[i])) * 1e-6
  if (!(ridge > 0)) throw new Error('Cannot fit risk parity to constant development legs')
  for (const [i, row] of covariance.entries()) row[i] += ridge
  const w = covariance.map((row, i) => 1 / Math.sqrt(row[i]))
  for (let sweep = 0; sweep < 2000; sweep++) {
    let movement = 0
    for (const [i, row] of covariance.entries()) {
      const other = sum(row.map((s, j) => (j === i ? 0 : s * w[j])))
      const root = Math.sqrt(other ** 2 + 4 * row[i])
      const next = other > 0 ? 2 / (root + other) : (root - other) / (2 * row[i])
      movement = Math.max(movement, Math.abs(next / w[i] - 1))
      w[i] = next
    }
    if (movement < 1e-10) {
      const total = sum(w)
      return w.map((weight) => weight / total)
    }
  }
  throw new Error('Development risk parity failed to converge')
}
