import { capital, sellFee } from './pairs-pead-protocol'
import { netAt, type Ledger } from './pairs-pead-replay'
import { dailySharpe, deflatedSharpe } from './research-orb-zab-statistics'

export const bootstrap = { replicates: 10_000, intradayBlock: 5, dailyBlock: 10, seed: 0x27f22fed } as const
const sum = (a: readonly number[]) => a.reduce((s, x) => s + x, 0)

export const circularP = (a: readonly number[], size: number): number | null => {
  const n = a.length
  if (n < size * 2 || a.every((x) => x === a[0])) return null
  const observed = sum(a)
  const mean = observed / n
  const prefix = new Float64Array(n * 2 + 1)
  const blocks = new Float64Array(n)
  const tail = new Float64Array(n)
  const k = Math.floor(n / size),
    r = n % size
  for (let i = 0; i < 2 * n; i++) prefix[i + 1] = prefix[i] + a[i % n] - mean
  for (let i = 0; i < n; i++) {
    blocks[i] = prefix[i + size] - prefix[i]
    tail[i] = prefix[i + r] - prefix[i]
  }
  let state: number = bootstrap.seed
  const sample = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % n
  }
  let exceed = 0
  for (let i = 0; i < bootstrap.replicates; i++) {
    let value = 0
    for (let j = 0; j < k; j++) value += blocks[sample()]
    if (r > 0) value += tail[sample()]
    if (value >= observed) exceed++
  }
  return (1 + exceed) / (1 + bootstrap.replicates)
}

export const rawPath = (ledger: Ledger, indices: readonly number[], bps: number, omit?: Ledger) =>
  indices.map((d) => netAt(ledger, d, bps) - (omit === undefined ? 0 : netAt(omit, d, bps)))

export const exTop5 = (values: readonly number[]) =>
  values.length <= 5 ? null : sum(values.toSorted((a, b) => b - a).slice(5))

export const marketBeta = (pnl: readonly number[], marketReturns: readonly number[]) => {
  if (pnl.length < 2) return null
  const avgPnl = sum(pnl) / pnl.length
  const avgMarket = sum(marketReturns) / marketReturns.length
  let cov = 0,
    variance = 0
  for (let i = 0; i < pnl.length; i++) {
    const change = marketReturns[i] - avgMarket
    cov += ((pnl[i] - avgPnl) / capital) * change
    variance += change ** 2
  }
  return variance > 0 ? cov / variance : null
}

export const summarize = (
  ledger: Ledger,
  indices: readonly number[],
  bps: number,
  block: number,
  benchmark: number | null,
  marketReturns: readonly number[],
  bootstrapEnabled = true,
) => {
  const path = rawPath(ledger, indices, bps)
  const total = (f: keyof Ledger) => indices.reduce((s, i) => s + ledger[f][i], 0)
  const max = (f: keyof Ledger) => indices.reduce((m, i) => Math.max(m, Math.abs(ledger[f][i])), 0)
  const missing = total('missing')
  const complete = missing === 0 && path.length > 0
  let equity = 0,
    peak = 0,
    drawdown = 0
  for (const p of path) {
    equity += p
    peak = Math.max(peak, equity)
    drawdown = Math.max(drawdown, peak - equity)
  }
  const sr = dailySharpe(path)
  return {
    sessions: path.length,
    tradedDays: indices.filter((i) => ledger.entries[i] > 0 || ledger.exits[i] > 0 || ledger.markedGross[i] > 0).length,
    entries: total('entries'),
    exits: total('exits'),
    missing,
    unfilled: total('unfilled'),
    gross: total('gross'),
    slippage: (total('halfTurnover') * bps) / 10_000,
    fees: total('sales') * sellFee,
    borrow: total('borrow'),
    supportedNet: sum(path),
    net: complete ? sum(path) : null,
    sharpe: complete && sr !== null ? sr * Math.sqrt(252) : null,
    maxDrawdown: complete ? drawdown : null,
    exTop5: complete ? exTop5(path) : null,
    bootP: complete && bootstrapEnabled ? circularP(path, block) : null,
    dsr: complete ? deflatedSharpe(path, benchmark) : null,
    betaToSpy: complete
      ? marketBeta(
          path,
          indices.map((d) => marketReturns[d]),
        )
      : null,
    maxPostOpenGross: max('fillGross'),
    maxCloseGross: max('markedGross'),
    maxAbsCloseNet: max('markedNet'),
    closeGrossCapBreachDays: indices.filter((i) => ledger.markedGross[i] > capital + 1e-7).length,
  }
}

export const omitSummary = (ledger: Ledger, omit: Ledger, indices: readonly number[], bps: number) => {
  const path = rawPath(ledger, indices, bps, omit)
  const missing = indices.reduce((s, i) => s + ledger.missing[i] - omit.missing[i], 0)
  return missing === 0 && indices.length > 0 ? [sum(path), exTop5(path)] : [null, null]
}
