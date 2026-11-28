import { initialEquity, type LedgerRow, type Mode } from './pure-etf-dual-horizon-account'
import { elapsedDays } from './research-lib/calendar'
import {
  calmar,
  exTopExcess,
  maxDrawdown,
  sharpe,
  sortino,
  type StationaryPlan,
  sum,
  wealth,
} from './research-lib/statistics'

const mean = (x: readonly number[]) => sum(x) / x.length
const covarianceSum = (a: readonly number[], b: readonly number[]) => {
  const am = mean(a)
  const bm = mean(b)
  return a.reduce((total, x, i) => total + (x - am) * (b[i] - bm), 0)
}
export const summarize = (
  dates: readonly string[],
  net: readonly number[],
  shy: readonly number[],
  spy: readonly number[],
  mode: Mode,
) => {
  const years = (elapsedDays(dates[0], dates[dates.length - 1]) + 1) / 365.2425
  const compound = mode === 'compound'
  const nav = wealth(net, compound)
  const shyNav = wealth(shy, compound)
  const cagr = nav > 0 ? nav ** (1 / years) - 1 : null
  const drawdown = maxDrawdown(net, compound)
  const marketVariance = covarianceSum(spy, spy)
  const [exTop5, exTop10] = exTopExcess(net, shy, compound, [5, 10])
  return {
    sessions: net.length,
    finalEquity: nav * initialEquity,
    netReturn: nav - 1,
    cagr,
    excessOverShy: nav - shyNav,
    excessOverShyUsd: (nav - shyNav) * initialEquity,
    irOverShy: sharpe(net.map((r, i) => r - shy[i])),
    sharpe: sharpe(net),
    sortino: sortino(net),
    maxDrawdown: drawdown,
    calmar: calmar(cagr, drawdown),
    exTop5ExcessOverShy: exTop5,
    exTop10ExcessOverShy: exTop10,
    spyBeta: marketVariance > 0 ? covarianceSum(net, spy) / marketVariance : null,
    downSpyNet:
      wealth(
        net.filter((_, i) => spy[i] < 0),
        compound,
      ) - 1,
  }
}

export const attribution = (rows: readonly LedgerRow[]) => {
  const total = (key: 'pnl' | 'o1Pnl' | 'o2Pnl' | 'shyPnl' | 'noisePnl' | 'slippage' | 'fee' | 'borrow' | 'debit') =>
    rows.reduce((sum, row) => sum + row[key], 0)
  return {
    O1: total('o1Pnl'),
    O2: total('o2Pnl'),
    intraday: total('noisePnl'),
    SHYSweep: total('shyPnl'),
    slippage: -total('slippage'),
    sellFee: -total('fee'),
    borrow: -total('borrow'),
    marginDebit: -total('debit'),
    total: total('pnl'),
  }
}

export const correlations = (returns: Record<string, readonly number[]>, observations: readonly number[]) => {
  const order = Object.keys(returns)
  const samples = order.map((id) => observations.map((i) => returns[id][i]))
  const variances = samples.map((r) => covarianceSum(r, r))
  return {
    sessions: observations.length,
    order,
    matrix: samples.map((a, i) =>
      samples.map((b, j) => {
        const denominator = Math.sqrt(variances[i] * variances[j])
        return denominator > 0 ? covarianceSum(a, b) / denominator : null
      }),
    ),
  }
}

export const spyDrawdownIndices = (spy: readonly number[]) => {
  let nav = 1
  let peak = 1
  return spy.flatMap((r, i) => {
    nav *= 1 + r
    peak = Math.max(peak, nav)
    return nav < peak ? [i] : []
  })
}

// Politis–Romano circular stationary bootstrap, fixed xorshift32 seed and geometric mean block length 10.
export const bootstrapProtocol = { draws: 10_000, meanBlock: 10, seed: 0x7ca4da11 } as const
export const bootstrapRisk = (net: readonly number[], shy: readonly number[], mode: Mode, plan: StationaryPlan) => {
  const size = net.length
  if (plan.sessions !== size || shy.length !== size) throw new Error('Stationary bootstrap length mismatch')
  const excess = net.map((x, i) => x - shy[i])
  const observed = sum(excess)
  const center = observed / size
  const prefix = new Float64Array(2 * size + 1)
  const returns = Float64Array.from([...net, ...net])
  for (let i = 0; i < 2 * size; i++) prefix[i + 1] = prefix[i] + (excess[i % size] - center)
  const compound = mode === 'compound'
  const drawdowns: number[] = []
  let tails = 0
  for (let draw = 0; draw < plan.draws; draw++) {
    let sampled = 0
    let nav = 1
    let peak = 1
    let maxDd = 0
    for (let i = plan.offsets[draw]; i < plan.offsets[draw + 1]; i += 2) {
      const start = plan.blocks[i]
      const end = plan.blocks[i + 1]
      sampled += prefix[end] - prefix[start]
      // Uncentered returns for loss distribution; centered paired excess for the null.
      for (let j = start; j < end; j++) {
        nav = compound ? nav * (1 + returns[j]) : nav + returns[j]
        if (nav > peak) peak = nav
        const dd = 1 - nav / peak
        if (dd > maxDd) maxDd = dd
      }
    }
    if (sampled >= observed) tails++
    drawdowns.push(maxDd)
  }
  drawdowns.sort((a, b) => a - b)
  const cut = Math.ceil(drawdowns.length * 0.95)
  return {
    draws: drawdowns.length,
    pExcess: (1 + tails) / (drawdowns.length + 1),
    maxDrawdownVaR95: drawdowns[cut - 1],
    maxDrawdownCVaR95: mean(drawdowns.slice(cut)),
  }
}
