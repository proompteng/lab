import { initialEquity, type LedgerRow, type Mode } from './pure-etf-dual-horizon-account'
import { elapsedDays } from './pure-etf-dual-horizon-data'

const sum = (x: readonly number[]) => x.reduce((a, b) => a + b, 0)
const mean = (x: readonly number[]) => sum(x) / x.length
const annual = Math.sqrt(252)
const covarianceSum = (a: readonly number[], b: readonly number[]) => {
  const am = mean(a)
  const bm = mean(b)
  return a.reduce((total, x, i) => total + (x - am) * (b[i] - bm), 0)
}
const sharpe = (net: readonly number[]) => {
  const sd = Math.sqrt(covarianceSum(net, net) / (net.length - 1))
  return sd > 0 ? (mean(net) * annual) / sd : null
}
const wealth = (returns: readonly number[], mode: Mode) =>
  mode === 'fixed' ? 1 + sum(returns) : returns.reduce((x, r) => x * (1 + r), 1)

export const pathDrawdown = (returns: readonly number[], mode: Mode) => {
  let equity = 1
  let peak = 1
  let drawdown = 0
  for (const r of returns) {
    equity = mode === 'fixed' ? equity + r : equity * (1 + r)
    peak = Math.max(peak, equity)
    drawdown = Math.max(drawdown, 1 - equity / peak)
  }
  return drawdown
}

export const summarize = (
  dates: readonly string[],
  net: readonly number[],
  shy: readonly number[],
  spy: readonly number[],
  mode: Mode,
) => {
  const years = (elapsedDays(dates[0], dates[dates.length - 1]) + 1) / 365.2425
  const nav = wealth(net, mode)
  const shyNav = wealth(shy, mode)
  const cagr = nav > 0 ? nav ** (1 / years) - 1 : null
  const maxDrawdown = pathDrawdown(net, mode)
  const downside = Math.sqrt(mean(net.map((r) => Math.min(0, r) ** 2)))
  const marketVariance = covarianceSum(spy, spy)
  const best = net
    .map((r, i) => ({ i, r }))
    .filter(({ r }) => r > 0)
    .sort((a, b) => b.r - a.r || a.i - b.i)
  const exTop = (count: number) => {
    const exclude = new Set(best.slice(0, count).map(({ i }) => i))
    return (
      wealth(
        net.filter((_, i) => !exclude.has(i)),
        mode,
      ) -
      wealth(
        shy.filter((_, i) => !exclude.has(i)),
        mode,
      )
    )
  }
  return {
    sessions: net.length,
    finalEquity: nav * initialEquity,
    netReturn: nav - 1,
    cagr,
    excessOverShy: nav - shyNav,
    excessOverShyUsd: (nav - shyNav) * initialEquity,
    irOverShy: sharpe(net.map((r, i) => r - shy[i])),
    sharpe: sharpe(net),
    sortino: downside > 0 ? (mean(net) * annual) / downside : null,
    maxDrawdown,
    calmar: maxDrawdown > 0 && cagr !== null ? cagr / maxDrawdown : null,
    exTop5ExcessOverShy: exTop(5),
    exTop10ExcessOverShy: exTop(10),
    spyBeta: marketVariance > 0 ? covarianceSum(net, spy) / marketVariance : null,
    downSpyNet:
      wealth(
        net.filter((_, i) => spy[i] < 0),
        mode,
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
export const stationaryBlocks = (n: number, draws: number = bootstrapProtocol.draws) => {
  let seed: number = bootstrapProtocol.seed
  const random = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return ((seed >>> 0) + 0.5) / 2 ** 32
  }
  const geometric = Math.log1p(-1 / bootstrapProtocol.meanBlock)
  const blocks: number[] = []
  for (let k = 0; k < draws; k++) {
    for (let left = n; left > 0; ) {
      const start = Math.floor(random() * n)
      const length = Math.min(left, 1 + Math.floor(Math.log(random()) / geometric))
      blocks.push(start, start + length)
      left -= length
    }
  }
  return Int32Array.from(blocks)
}

export const bootstrapRisk = (net: readonly number[], shy: readonly number[], mode: Mode, blocks: Int32Array) => {
  const size = net.length
  const excess = net.map((x, i) => x - shy[i])
  const observed = sum(excess)
  const center = observed / size
  const prefix = new Float64Array(2 * size + 1)
  const returns = Float64Array.from([...net, ...net])
  for (let i = 0; i < 2 * size; i++) prefix[i + 1] = prefix[i] + (excess[i % size] - center)
  const compound = mode === 'compound'
  const drawdowns: number[] = []
  let tails = 0
  let sampled = 0
  let length = 0
  let nav = 1
  let peak = 1
  let maxDd = 0
  for (let i = 0; i < blocks.length; i += 2) {
    const start = blocks[i]
    const end = blocks[i + 1]
    sampled += prefix[end] - prefix[start]
    length += end - start
    // Uncentered returns for loss distribution; centered paired excess for the null.
    for (let j = start; j < end; j++) {
      nav = compound ? nav * (1 + returns[j]) : nav + returns[j]
      if (nav > peak) peak = nav
      const dd = 1 - nav / peak
      if (dd > maxDd) maxDd = dd
    }
    if (length !== size) continue
    if (sampled >= observed) tails++
    drawdowns.push(maxDd)
    sampled = length = maxDd = 0
    nav = peak = 1
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
